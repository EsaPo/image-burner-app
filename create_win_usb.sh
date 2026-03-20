#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

start_time=$(date +%s)

ISO_PATH="$1"
USB_BLOCK="$2"

echo "Checking prerequisites..."

# Check if ISO exists
if [ ! -f "$ISO_PATH" ]; then
    echo "❌ Error: ISO file not found: $ISO_PATH"
    exit 1
fi

# Check if device exists
if [ ! -b "$USB_BLOCK" ]; then
    echo "❌ Error: Device not found: $USB_BLOCK"
    lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,MODEL
    exit 1
fi

export LC_NUMERIC=C
export LANG=C

ISO_MOUNT=$(mktemp -d)
NTFS_MOUNT=$(mktemp -d)
UEFI_MOUNT=$(mktemp -d)
UEFI_NTFS_URL="https://github.com/pbatard/rufus/raw/master/res/uefi/uefi-ntfs.img"
UEFI_NTFS_IMG="/tmp/uefi-ntfs.img"

cleanup() {
  echo "🧹 Cleaning up..."
  umount "$NTFS_MOUNT" 2>/dev/null || true
  umount "$UEFI_MOUNT" 2>/dev/null || true
  umount "$ISO_MOUNT" 2>/dev/null || true
  rm -rf "$NTFS_MOUNT" "$UEFI_MOUNT" "$ISO_MOUNT"
  sync
}
trap cleanup EXIT

echo "📀 Preparing device $USB_BLOCK..."

# Step 1: Unmount everything
echo "Unmounting all partitions..."
for partition in ${USB_BLOCK}* ; do
  if [ "$partition" != "$USB_BLOCK" ] && [ -b "$partition" ]; then
    umount "$partition" 2>/dev/null || true
  fi
done

# Step 2: Kill any processes using the device
fuser -km "$USB_BLOCK" 2>/dev/null || true
sleep 1

# Step 3: Zero out the beginning of the disk (first 10MB)
echo "Clearing partition table..."
dd if=/dev/zero of="$USB_BLOCK" bs=1M count=10 conv=fsync status=none 2>/dev/null || true
sync
sleep 2

# Step 4: Inform kernel of changes
partprobe "$USB_BLOCK" 2>/dev/null || true
blockdev --rereadpt "$USB_BLOCK" 2>/dev/null || true
sleep 2

# Step 5: Verify device is accessible
if ! dd if="$USB_BLOCK" of=/dev/null bs=512 count=1 2>/dev/null; then
  echo "❌ Error: Cannot read from $USB_BLOCK"
  echo "Try unplugging and replugging the USB drive, then try again."
  exit 1
fi

echo "🧩 Creating GPT partition table..."
parted -s "$USB_BLOCK" mklabel gpt || {
  echo "❌ Error: Failed to create partition table"
  echo "Device info:"
  lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL
  exit 1
}

sleep 2
partprobe "$USB_BLOCK"
sleep 2

# Get disk size
DISK_SIZE_MB=$(parted -sm "$USB_BLOCK" unit MB print 2>/dev/null | awk -F: '/^\/dev\// {gsub(/MB/,"",$2); print int($2)}')

if [ -z "$DISK_SIZE_MB" ] || [ "$DISK_SIZE_MB" -eq 0 ]; then
  echo "❌ Error: Could not determine disk size"
  parted "$USB_BLOCK" print
  exit 1
fi

echo "Disk size: ${DISK_SIZE_MB}MB"

FAT_SIZE_MB=8
NTFS_END=$((DISK_SIZE_MB - FAT_SIZE_MB))

echo "Creating partitions..."
parted -s "$USB_BLOCK" mkpart WINDOWS ntfs 1MiB "${NTFS_END}MB"
parted -s "$USB_BLOCK" mkpart UEFI_NTFS fat32 "${NTFS_END}MB" 100%
parted -s "$USB_BLOCK" set 2 boot on
parted -s "$USB_BLOCK" set 2 esp on

partprobe "$USB_BLOCK"
udevadm settle --timeout=10 2>/dev/null || true
sleep 5

# Wait for partitions
echo "Waiting for partitions..."
for i in {1..15}; do
  if [ -b "${USB_BLOCK}1" ] && [ -b "${USB_BLOCK}2" ]; then
    echo "✓ Partitions ready"
    break
  fi
  echo "  Attempt $i/15..."
  sleep 2
  partprobe "$USB_BLOCK" 2>/dev/null || true
done

if [ ! -b "${USB_BLOCK}1" ]; then
  echo "❌ Error: Partition 1 (${USB_BLOCK}1) not found"
  ls -la ${USB_BLOCK}*
  exit 1
fi

if [ ! -b "${USB_BLOCK}2" ]; then
  echo "❌ Error: Partition 2 (${USB_BLOCK}2) not found"
  ls -la ${USB_BLOCK}*
  exit 1
fi

echo "🧱 Formatting partitions..."
mkfs.ntfs -f -L WINDOWS "${USB_BLOCK}1"
sleep 2
mkfs.vfat -n UEFI_NTFS "${USB_BLOCK}2"
sleep 2

echo "📂 Mounting filesystems..."
mount -o loop "$ISO_PATH" "$ISO_MOUNT"
mount "${USB_BLOCK}1" "$NTFS_MOUNT"

echo "📦 Copying Windows files (10-15 minutes)..."
rsync -ah --info=progress2 "$ISO_MOUNT"/ "$NTFS_MOUNT"/

echo ""
echo "💾 Flushing data to USB drive (5-10 minutes)..."
echo "Ensuring all cached data is written to the device..."

# Get initial dirty data
DIRTY_INITIAL=$(grep -E "^Dirty:" /proc/meminfo | awk '{print $2}')

sync &
SYNC_PID=$!

# Monitor dirty pages being written
while kill -0 $SYNC_PID 2>/dev/null; do
  DIRTY_NOW=$(grep -E "^Dirty:" /proc/meminfo | awk '{print $2}')
  
  if [ "$DIRTY_INITIAL" -gt 0 ]; then
    PERCENT=$(( (DIRTY_INITIAL - DIRTY_NOW) * 100 / DIRTY_INITIAL ))
    PERCENT=$((PERCENT > 100 ? 100 : PERCENT))
  else
    PERCENT=100
  fi
  
  # Simple progress bar with ASCII characters
  FILLED=$((PERCENT / 10))
  EMPTY=$((10 - FILLED))
  BAR=$(printf '%0.s#' $(seq 1 $FILLED))
  SPACE=$(printf '%0.s-' $(seq 1 $EMPTY))
  
  DIRTY_MB=$((DIRTY_NOW / 1024))
  echo "Progress: [$BAR$SPACE] ${PERCENT}% - ${DIRTY_MB}MB remaining to write"
  sleep 2
done

wait $SYNC_PID 2>/dev/null || true

echo "Progress: [##########] 100% - Complete!"
echo "✅ All data safely written to USB!"

umount "$NTFS_MOUNT"
sleep 2

echo "💾 Installing UEFI:NTFS..."
mount "${USB_BLOCK}2" "$UEFI_MOUNT"

if command -v wget >/dev/null 2>&1; then
  wget -q --show-progress -O "$UEFI_NTFS_IMG" "$UEFI_NTFS_URL" 2>/dev/null || true
elif command -v curl >/dev/null 2>&1; then
  curl -sL -o "$UEFI_NTFS_IMG" "$UEFI_NTFS_URL" 2>/dev/null || true
fi

if [ -f "$UEFI_NTFS_IMG" ]; then
  umount "$UEFI_MOUNT"
  dd if="$UEFI_NTFS_IMG" of="${USB_BLOCK}2" bs=1M status=progress conv=fsync
  rm -f "$UEFI_NTFS_IMG"
  echo "✅ UEFI:NTFS installed"
else
  mount "${USB_BLOCK}1" "$NTFS_MOUNT"
  mkdir -p "$UEFI_MOUNT/EFI/Boot"
  cp "$NTFS_MOUNT/efi/boot/bootx64.efi" "$UEFI_MOUNT/EFI/Boot/" 2>/dev/null || true
  umount "$NTFS_MOUNT"
  umount "$UEFI_MOUNT"
fi

echo "🧰 Installing GRUB..."
if command -v grub2-install >/dev/null 2>&1; then
  mount "${USB_BLOCK}1" "$NTFS_MOUNT"
  grub2-install --target=i386-pc --boot-directory="$NTFS_MOUNT/boot" --force "$USB_BLOCK" 2>/dev/null || true
  mkdir -p "$NTFS_MOUNT/boot/grub2"
  cat > "$NTFS_MOUNT/boot/grub2/grub.cfg" <<'EOF'
set timeout=3
menuentry "Windows Installer" {
  insmod part_gpt
  insmod ntfs
  chainloader +1
}
EOF
  umount "$NTFS_MOUNT"
fi

cleanup

duration=$(( ($(date +%s) - start_time) / 60 ))
echo ""
echo "✅ Done in ${duration} min!"
