use super::*;

const ADDR: [u8; 6] = [3, 0, 0, 0x42, 0x54, 2];

fn cmd(b: &mut Ble, op: u16, params: &[u8], now: u64) {
    let mut p = vec![0x01, op as u8, (op >> 8) as u8, params.len() as u8];
    p.extend_from_slice(params);
    b.host_send(&p, now);
}

/// All packets due in [0, until)
fn drain(b: &mut Ble, until: u64) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut t = 0;
    while t < until {
        while let Some(p) = b.poll(t) {
            out.push(p);
        }
        t += 1000;
    }
    out
}

/// Minimal peripheral host: reset, enable LE events, set advertising data, start advertising
fn advertise(b: &mut Ble) {
    cmd(b, 0x0c03, &[], 0);
    cmd(b, 0x0c01, &[0xff; 8], 0);
    cmd(b, 0x2001, &[0xff, 0x01, 0, 0, 0, 0, 0, 0], 0);
    let name = b"TryBoard-HR";
    let mut d = vec![2, 1, 6, name.len() as u8 + 1, 9];
    d.extend_from_slice(name);
    let mut p = vec![d.len() as u8];
    p.extend_from_slice(&d);
    p.resize(32, 0);
    cmd(b, 0x2008, &p, 0);
    cmd(b, 0x200a, &[1], 0);
}

#[test]
fn reset_answers_command_complete() {
    let mut b = Ble::new(ADDR);
    cmd(&mut b, 0x0c03, &[], 0);
    let p = drain(&mut b, 10_000);
    assert_eq!(p[0][..7], [0x04, 0x0e, 4, 1, 0x03, 0x0c, 0]);
}

#[test]
fn bredr_commands_are_refused_and_counted() {
    let mut b = Ble::new(ADDR);
    // HCI_Inquiry (0x0401): BR/EDR only -> Command Complete with 0x01 Unknown HCI Command
    cmd(&mut b, 0x0401, &[0x33, 0x8b, 0x9e, 8, 0], 0);
    let p = drain(&mut b, 10_000);
    assert_eq!(p[0][..7], [0x04, 0x0e, 4, 1, 0x01, 0x04, 0x01]);
    assert_eq!(b.bredr_cmds, [(0x0401, 1)]);
    assert!(b.unknown_cmds.is_empty());
}

#[test]
fn read_bd_addr_is_ours() {
    let mut b = Ble::new(ADDR);
    cmd(&mut b, 0x1009, &[], 0);
    let p = drain(&mut b, 10_000);
    assert_eq!(p[0][7..13], ADDR);
}

#[test]
fn vendor_read_static_addr_returns_six_bytes() {
    let mut b = Ble::new(ADDR);
    cmd(&mut b, 0xfc01, &[], 0);
    let p = drain(&mut b, 10_000);
    // Command Complete: plen 10 = ncmd + opcode + status + 6-byte address
    assert_eq!(p[0][..7], [0x04, 0x0e, 10, 1, 0x01, 0xfc, 0]);
    assert_eq!(p[0][7..13], [3, 0, 0, 0x42, 0x54, 0xc2]);
    assert_eq!(p[0][12] & 0xc0, 0xc0);
}

#[test]
fn phone_scans_connects_and_starts_att() {
    let mut b = Ble::new(ADDR);
    advertise(&mut b);
    b.phone_cmd("auto", 0).unwrap();
    let p = drain(&mut b, 500_000);
    // LE Connection Complete (legacy or enhanced)
    assert!(
        p.iter()
            .any(|e| e[0] == 0x04 && e[1] == 0x3e && (e[3] == 0x01 || e[3] == 0x0a)),
        "no connection complete event"
    );
    assert!(b.connected());
    // The phone's first ATT request is MTU exchange (ACL -> L2CAP CID 4 -> opcode 0x02)
    let att: Vec<_> = p.iter().filter(|e| e[0] == 0x02).collect();
    assert!(
        att.iter().any(|e| e.len() > 9 && e[7] == 4 && e[9] == 0x02),
        "no MTU request"
    );
    assert!(b.json().contains("TryBoard-HR"));
}

#[test]
fn same_inputs_same_air_log() {
    let run = || {
        let mut b = Ble::new(ADDR);
        advertise(&mut b);
        b.phone_cmd("auto", 0).unwrap();
        drain(&mut b, 300_000);
        b.log_json(0)
    };
    assert_eq!(run(), run());
}

#[test]
fn phone_disconnect_reports_reason_13() {
    let mut b = Ble::new(ADDR);
    advertise(&mut b);
    b.phone_cmd("auto", 0).unwrap();
    drain(&mut b, 200_000);
    b.phone_cmd("disconnect", 200_000).unwrap();
    let mut t = 200_000;
    let mut got = false;
    while t < 400_000 {
        while let Some(e) = b.poll(t) {
            got |= e[..2] == [0x04, 0x05] && e[6] == 0x13;
        }
        t += 1000;
    }
    assert!(got && !b.connected());
}

#[test]
fn bad_phone_command_is_an_error() {
    let mut b = Ble::new(ADDR);
    assert!(b.phone_cmd("fly", 0).is_err());
}

#[test]
fn adv_helpers() {
    let d = [2, 1, 6, 5, 2, 0x0d, 0x18, 0x0f, 0x18, 3, 9, b'H', b'R'];
    assert_eq!(adv_name(&d).as_deref(), Some("HR"));
    assert_eq!(adv_uuids(&d), vec![0x180d, 0x180f]);
    // Truncated fields must not read out of bounds
    assert_eq!(adv_name(&[5, 9, b'a']), None);
    assert_eq!(fmt_addr(&ADDR), "02:54:42:00:00:03");
    assert_eq!(json_str("a\"b\n"), "\"a\\\"b\\n\"");
}
