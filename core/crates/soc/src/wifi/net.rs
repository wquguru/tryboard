//! Virtual LAN: a 'router' behind the AP (192.168.4.1) with ARP, DHCP, ICMP echo and (net::tcp) DNS / HTTP.
//! Works on Ethernet frames: input (src MAC, dst MAC, ethertype, payload), replies in the same form.

use super::frame::Mac;

pub const GW_MAC: Mac = [0x02, 0x54, 0x42, 0xff, 0x00, 0x01];
pub const GW_IP: [u8; 4] = [192, 168, 4, 1];
pub const MASK: [u8; 4] = [255, 255, 255, 0];
pub const STA_IP: [u8; 4] = [192, 168, 4, 100];

pub const ETH_IP: u16 = 0x0800;
pub const ETH_ARP: u16 = 0x0806;

pub struct Eth {
    pub dst: Mac,
    pub src: Mac,
    pub ethertype: u16,
    pub payload: Vec<u8>,
}

pub struct Net {
    /// Address leased to the chip (after DHCP ACK)
    pub leased: bool,
    pub log: Vec<String>,
    pub tcp: super::tcp::Tcp,
    /// 网关（兼 DHCP / DNS）与分给芯片的地址：缺省 192.168.4.1 / .100；
    /// 有虚拟手机配网时路由器换到 192.168.5.x，避开固件热点自己的 192.168.4.x（见 DECISIONS C-02）
    pub gw: [u8; 4],
    pub sta_ip: [u8; 4],
    /// 最近一个 TCP 段的来源 MAC（芯片）：真实网络的回复晚到，要知道发给谁
    peer_mac: Mac,
    /// 不是对某一帧的即时回应、要主动发给芯片的帧（真实网络的回复，C-03）；World::poll 取走
    pub pending: Vec<Eth>,
}

impl Default for Net {
    fn default() -> Self {
        Net {
            leased: false,
            log: Vec::new(),
            tcp: Default::default(),
            gw: GW_IP,
            sta_ip: STA_IP,
            peer_mac: [0; 6],
            pending: Vec::new(),
        }
    }
}

pub fn checksum(data: &[u8], init: u32) -> u16 {
    let mut s = init;
    for c in data.chunks(2) {
        let w = if c.len() == 2 {
            u16::from_be_bytes([c[0], c[1]])
        } else {
            (c[0] as u16) << 8
        };
        s += w as u32;
    }
    while s >> 16 != 0 {
        s = (s & 0xffff) + (s >> 16);
    }
    !(s as u16)
}

/// Build an IPv4 packet (TTL 64, no options)
pub fn ipv4(src: [u8; 4], dst: [u8; 4], proto: u8, payload: &[u8], id: u16) -> Vec<u8> {
    let len = 20 + payload.len();
    let mut p = vec![
        0x45,
        0,
        (len >> 8) as u8,
        len as u8,
        (id >> 8) as u8,
        id as u8,
        0x40,
        0,
        64,
        proto,
        0,
        0,
    ];
    p.extend_from_slice(&src);
    p.extend_from_slice(&dst);
    let c = checksum(&p, 0);
    p[10] = (c >> 8) as u8;
    p[11] = c as u8;
    p.extend_from_slice(payload);
    p
}

/// UDP / TCP pseudo-header checksum
pub fn l4_checksum(src: [u8; 4], dst: [u8; 4], proto: u8, seg: &[u8]) -> u16 {
    let mut s = 0u32;
    for w in [src, dst] {
        s += u16::from_be_bytes([w[0], w[1]]) as u32 + u16::from_be_bytes([w[2], w[3]]) as u32;
    }
    s += proto as u32 + seg.len() as u32;
    checksum(seg, s)
}

pub fn udp(src: [u8; 4], dst: [u8; 4], sport: u16, dport: u16, data: &[u8]) -> Vec<u8> {
    let len = 8 + data.len();
    let mut u = vec![
        (sport >> 8) as u8,
        sport as u8,
        (dport >> 8) as u8,
        dport as u8,
        (len >> 8) as u8,
        len as u8,
        0,
        0,
    ];
    u.extend_from_slice(data);
    let c = l4_checksum(src, dst, 17, &u);
    let c = if c == 0 { 0xffff } else { c };
    u[6] = (c >> 8) as u8;
    u[7] = c as u8;
    u
}

fn ip4(b: &[u8]) -> [u8; 4] {
    [b[0], b[1], b[2], b[3]]
}

fn ip_str(ip: &[u8; 4]) -> String {
    format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
}

impl Net {
    fn reply_ip(
        &mut self,
        to: &Mac,
        dst_ip: [u8; 4],
        src_ip: [u8; 4],
        proto: u8,
        payload: &[u8],
    ) -> Eth {
        let id = self.tcp.next_ip_id();
        Eth {
            dst: *to,
            src: GW_MAC,
            ethertype: ETH_IP,
            payload: ipv4(src_ip, dst_ip, proto, payload, id),
        }
    }

    /// 网页送来真实网络的回复（脚本动作 netreply=）：回复段排进 pending，下一次 World::poll 发给芯片
    pub fn real_reply(&mut self, id: u32, status: u16, info: &str, body: &[u8], now_us: u64) {
        let segs = self.tcp.real_reply(id, status, info, body, now_us);
        let to = self.peer_mac;
        for ((chip, _, server, _), seg, line) in segs {
            if let Some(l) = line {
                self.log.push(l);
            }
            let e = self.reply_ip(&to, chip, server, 6, &seg);
            self.pending.push(e);
        }
    }

    pub fn on_eth(&mut self, e: &Eth, now_us: u64) -> Vec<Eth> {
        self.tcp.now_us = now_us;
        match e.ethertype {
            ETH_ARP => self.arp(e),
            ETH_IP => self.ip(e, now_us),
            _ => vec![],
        }
    }

    fn arp(&mut self, e: &Eth) -> Vec<Eth> {
        let p = &e.payload;
        if p.len() < 28 || u16::from_be_bytes([p[6], p[7]]) != 1 {
            return vec![];
        }
        let target = ip4(&p[24..28]);
        // Gateway answers every LAN address except the chip's own (the chip asks for its own during DHCP conflict detection)
        if target == self.sta_ip || target == ip4(&p[14..18]) || target[..3] != self.gw[..3] {
            return vec![];
        }
        let mut r = vec![0, 1, 8, 0, 6, 4, 0, 2];
        r.extend_from_slice(&GW_MAC);
        r.extend_from_slice(&target);
        r.extend_from_slice(&p[8..14]);
        r.extend_from_slice(&p[14..18]);
        self.log.push(format!("ARP {} is gateway", ip_str(&target)));
        vec![Eth {
            dst: e.src,
            src: GW_MAC,
            ethertype: ETH_ARP,
            payload: r,
        }]
    }

    fn ip(&mut self, e: &Eth, now_us: u64) -> Vec<Eth> {
        let p = &e.payload;
        if p.len() < 20 || p[0] >> 4 != 4 {
            return vec![];
        }
        let ihl = (p[0] & 15) as usize * 4;
        let total = (u16::from_be_bytes([p[2], p[3]]) as usize).min(p.len());
        let (proto, src, dst) = (p[9], ip4(&p[12..16]), ip4(&p[16..20]));
        let body = &p[ihl..total];
        match proto {
            17 if body.len() >= 8 => {
                let (sport, dport) = (
                    u16::from_be_bytes([body[0], body[1]]),
                    u16::from_be_bytes([body[2], body[3]]),
                );
                let data = &body[8..];
                if dport == 67 {
                    return self.dhcp(data);
                }
                // Plain DNS (gateway port 53) and mDNS queries for .local names (224.0.0.251:5353), answered RFC 6762 §6.7
                // 'legacy unicast' style straight to the querier's port, echoing the ID and question
                if dport == 53 || dport == 5353 {
                    if let Some(ans) = self.tcp.dns(data, self.gw) {
                        self.log.push(ans.1);
                        let from = if dport == 53 { dst } else { self.gw };
                        let u = udp(from, src, dport, sport, &ans.0);
                        return vec![self.reply_ip(&e.src, src, from, 17, &u)];
                    }
                }
                vec![]
            }
            1 if body.len() >= 8 && body[0] == 8 => {
                // ICMP echo request -> echo reply
                let mut r = body.to_vec();
                r[0] = 0;
                r[2] = 0;
                r[3] = 0;
                let c = checksum(&r, 0);
                r[2] = (c >> 8) as u8;
                r[3] = c as u8;
                self.log.push(format!("ping {} → reply", ip_str(&dst)));
                vec![self.reply_ip(&e.src, src, dst, 1, &r)]
            }
            6 => {
                self.peer_mac = e.src;
                let segs = self.tcp.on_segment(src, dst, body, now_us);
                let mut out = Vec::new();
                for (seg, line) in segs {
                    if let Some(l) = line {
                        self.log.push(l);
                    }
                    out.push(self.reply_ip(&e.src, src, dst, 6, &seg));
                }
                out
            }
            _ => vec![],
        }
    }

    fn dhcp(&mut self, d: &[u8]) -> Vec<Eth> {
        if d.len() < 240 || d[0] != 1 || d[236..240] != [0x63, 0x82, 0x53, 0x63] {
            return vec![];
        }
        // Find the message type (option 53)
        let mut i = 240;
        let mut kind = 0;
        while i + 1 < d.len() && d[i] != 255 {
            if d[i] == 0 {
                i += 1;
                continue;
            }
            let l = d[i + 1] as usize;
            if d[i] == 53 && l >= 1 {
                kind = d[i + 2];
            }
            i += 2 + l;
        }
        let reply = match kind {
            1 => 2, // DISCOVER → OFFER
            3 => 5, // REQUEST → ACK
            _ => return vec![],
        };
        let mut r = vec![0u8; 240];
        r[0] = 2;
        r[1] = 1;
        r[2] = 6;
        r[4..8].copy_from_slice(&d[4..8]); // xid
        r[10..12].copy_from_slice(&d[10..12]); // flags
        let (gw, sta) = (self.gw, self.sta_ip);
        r[16..20].copy_from_slice(&sta); // yiaddr
        r[20..24].copy_from_slice(&gw); // siaddr
        r[28..44].copy_from_slice(&d[28..44]); // chaddr
        r[236..240].copy_from_slice(&[0x63, 0x82, 0x53, 0x63]);
        let opts: [(u8, Vec<u8>); 8] = [
            (53, vec![reply]),
            (54, gw.to_vec()),
            (51, 86_400u32.to_be_bytes().to_vec()),
            (58, 43_200u32.to_be_bytes().to_vec()),
            (1, MASK.to_vec()),
            (3, gw.to_vec()),
            (6, gw.to_vec()),
            (15, b"tryboard.local".to_vec()),
        ];
        for (k, v) in opts {
            r.push(k);
            r.push(v.len() as u8);
            r.extend_from_slice(&v);
        }
        r.push(255);
        if reply == 5 {
            self.leased = true;
        }
        self.log.push(format!(
            "DHCP {} → {} {}",
            if kind == 1 { "DISCOVER" } else { "REQUEST" },
            if reply == 2 { "OFFER" } else { "ACK" },
            ip_str(&sta)
        ));
        let bc = [255u8; 4];
        let u = udp(gw, bc, 67, 68, &r);
        let id = self.tcp.next_ip_id();
        vec![Eth {
            dst: [0xff; 6],
            src: GW_MAC,
            ethertype: ETH_IP,
            payload: ipv4(gw, bc, 17, &u, id),
        }]
    }
}
