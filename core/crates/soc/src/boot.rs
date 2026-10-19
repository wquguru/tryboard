//! Flash image layout shared by every chip: locate the app partition (moved from tryboard-esp32c3, R-05).

pub fn u32at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// Find the app in a flash image: factory or ota_0 from the partition table (0x8000);
/// an image that starts with an app (0xE9 and not a bootloader) is treated as the app.
pub fn find_app(flash: &[u8]) -> Result<u32, String> {
    let pt = 0x8000;
    if flash.len() > pt + 32 && flash[pt] == 0xAA && flash[pt + 1] == 0x50 {
        let mut ota0 = None;
        for i in 0..95 {
            let o = pt + i * 32;
            if flash[o] != 0xAA || flash[o + 1] != 0x50 {
                break;
            }
            let (ty, sub, off) = (flash[o + 2], flash[o + 3], u32at(flash, o + 4));
            if ty == 0 && sub == 0 {
                return Ok(off);
            }
            if ty == 0 && sub == 0x10 && ota0.is_none() {
                ota0 = Some(off);
            }
        }
        if let Some(o) = ota0 {
            return Ok(o);
        }
        return Err("no app partition in the partition table".into());
    }
    if flash.first() == Some(&0xE9) {
        return Ok(0);
    }
    Err("unrecognized flash image: no partition table and not an app image".into())
}

/// Chip ID from the image header (offset 12). If flash doesn't start with 0xE9, find the app in the partition table first.
pub fn image_chip_id(flash: &[u8]) -> Option<u16> {
    let off = find_app(flash).ok()? as usize;
    flash
        .get(off + 13)
        .map(|_| u16::from_le_bytes([flash[off + 12], flash[off + 13]]))
}
