#!/usr/bin/env python3
"""
snmp_backend.py - Multi-Connection SNMP-Metrik-Poller & Discovery-Engine für snmpbar.
Unterstützt:
- Polling mehrerer Verbindungen (Connections) parallel
- Discovery via --walk <host> <community> <version>
- 64-Bit High-Capacity Counters & mathematische Aggregation pro Verbindung
"""

import sys
import os
import json
import time
import socket
import struct
import ipaddress

CACHE_FILE = "/dev/shm/snmpbar_state.json"

# --- ASN.1 / BER Encoding & Decoding ---

def encode_length(length):
    if length < 0x80:
        return bytes([length])
    bs = []
    while length > 0:
        bs.append(length & 0xff)
        length >>= 8
    bs.reverse()
    return bytes([0x80 | len(bs)]) + bytes(bs)

def decode_length(data, offset):
    b = data[offset]
    offset += 1
    if b < 0x80:
        return b, offset
    num_bytes = b & 0x7f
    val = 0
    for _ in range(num_bytes):
        val = (val << 8) | data[offset]
        offset += 1
    return val, offset

def encode_oid(oid_str):
    parts = [int(p) for p in oid_str.strip('.').split('.')]
    if len(parts) < 2:
        return b''
    res = [40 * parts[0] + parts[1]]
    for p in parts[2:]:
        vlq = []
        if p == 0:
            vlq = [0]
        else:
            val = p
            vlq.append(val & 0x7f)
            val >>= 7
            while val > 0:
                vlq.append((val & 0x7f) | 0x80)
                val >>= 7
            vlq.reverse()
        res.extend(vlq)
    return bytes(res)

def decode_oid(data):
    if not data:
        return ""
    first = data[0]
    parts = [str(first // 40), str(first % 40)]
    i = 1
    while i < len(data):
        val = 0
        while i < len(data):
            b = data[i]
            i += 1
            val = (val << 7) | (b & 0x7f)
            if not (b & 0x80):
                break
        parts.append(str(val))
    return ".".join(parts)

def build_snmp_packet(version, community, pdu_type, req_id, oids):
    vb_bytes = b""
    for oid_str in oids:
        oid_raw = encode_oid(oid_str)
        oid_tlv = bytes([0x06]) + encode_length(len(oid_raw)) + oid_raw
        null_tlv = bytes([0x05, 0x00])
        varbind = bytes([0x30]) + encode_length(len(oid_tlv) + len(null_tlv)) + oid_tlv + null_tlv
        vb_bytes += varbind
        
    varbind_list = bytes([0x30]) + encode_length(len(vb_bytes)) + vb_bytes
    
    req_id_bytes = struct.pack(">I", req_id)
    req_id_tlv = bytes([0x02, len(req_id_bytes)]) + req_id_bytes
    err_stat_tlv = bytes([0x02, 0x01, 0x00])
    err_idx_tlv = bytes([0x02, 0x01, 0x00])
    
    pdu_content = req_id_tlv + err_stat_tlv + err_idx_tlv + varbind_list
    pdu = bytes([pdu_type]) + encode_length(len(pdu_content)) + pdu_content
    
    ver_tlv = bytes([0x02, 0x01, version])
    comm_bytes = community.encode('utf-8')
    comm_tlv = bytes([0x04, len(comm_bytes)]) + comm_bytes
    
    msg_content = ver_tlv + comm_tlv + pdu
    return bytes([0x30]) + encode_length(len(msg_content)) + msg_content

def parse_tlv(data, offset=0):
    tag = data[offset]
    offset += 1
    length, offset = decode_length(data, offset)
    val_bytes = data[offset:offset+length]
    offset += length
    return tag, length, val_bytes, offset

def parse_snmp_response(data):
    try:
        tag, _, seq_val, _ = parse_tlv(data, 0)
        off = 0
        tag, _, _, off = parse_tlv(seq_val, off)
        tag, _, _, off = parse_tlv(seq_val, off)
        pdu_tag, _, pdu_val, off = parse_tlv(seq_val, off)
        
        p_off = 0
        _, _, _, p_off = parse_tlv(pdu_val, p_off)
        _, _, err_status, p_off = parse_tlv(pdu_val, p_off)
        if int.from_bytes(err_status, 'big') != 0:
            return {}
        _, _, _, p_off = parse_tlv(pdu_val, p_off)
        
        _, _, vb_list, p_off = parse_tlv(pdu_val, p_off)
        v_off = 0
        res = {}
        while v_off < len(vb_list):
            _, _, vb, v_off = parse_tlv(vb_list, v_off)
            b_off = 0
            oid_tag, _, oid_raw, b_off = parse_tlv(vb, b_off)
            val_tag, _, val_raw, b_off = parse_tlv(vb, b_off)
            
            oid = decode_oid(oid_raw)
            if val_tag == 0x02:
                val = int.from_bytes(val_raw, 'big', signed=True)
            elif val_tag in (0x41, 0x42, 0x43, 0x46):
                val = int.from_bytes(val_raw, 'big', signed=False)
            elif val_tag == 0x04:
                try:
                    val = val_raw.decode('utf-8', errors='replace').strip()
                except:
                    val = val_raw.hex()
            elif val_tag == 0x06:
                val = decode_oid(val_raw)
            else:
                val = val_raw
            res[oid] = val
        return res
    except Exception:
        return {}

def snmp_get_multiple(host, community, oids, version=1, timeout=2.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    req_id = int(time.time() * 1000) & 0x7FFFFFFF
    pkt = build_snmp_packet(version, community, 0xa0, req_id, oids)
    try:
        s.sendto(pkt, (host, 161))
        resp, _ = s.recvfrom(65535)
        return parse_snmp_response(resp)
    except Exception:
        return {}
    finally:
        s.close()

def snmp_walk(host, community, root_oid, version=1, max_reps=500, timeout=2.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    current_oid = root_oid
    req_id = 1000
    results = {}
    
    for _ in range(max_reps):
        req_id += 1
        pkt = build_snmp_packet(version, community, 0xa1, req_id, [current_oid])
        try:
            s.sendto(pkt, (host, 161))
            resp, _ = s.recvfrom(65535)
            parsed = parse_snmp_response(resp)
            if not parsed:
                break
            next_oid, val = next(iter(parsed.items()))
            if not next_oid.startswith(root_oid.strip('.')):
                break
            results[next_oid] = val
            current_oid = next_oid
        except Exception:
            break
            
    s.close()
    return results

# --- Formatierungs-Funktionen (A: Ultra-kompakt, B: Kompakte IT-Norm, C: Schlankes Vollformat) ---

FIG_SPACE = "\u2007"

def format_rate(bits_per_sec, style="full"):
    try:
        bps = float(bits_per_sec)
    except (ValueError, TypeError):
        bps = 0.0
    if bps < 0:
        bps = 0.0

    if bps >= 1_000_000_000_000:
        val = f"{bps / 1_000_000_000_000:5.1f}".replace(" ", FIG_SPACE)
        unit = "T" if style == "compact" else ("Tb" if style == "short" else "Tbit")
    elif bps >= 1_000_000_000:
        val = f"{bps / 1_000_000_000:5.1f}".replace(" ", FIG_SPACE)
        unit = "G" if style == "compact" else ("Gb" if style == "short" else "Gbit")
    elif bps >= 1_000_000:
        val = f"{bps / 1_000_000:5.1f}".replace(" ", FIG_SPACE)
        unit = "M" if style == "compact" else ("Mb" if style == "short" else "Mbit")
    elif bps >= 1_000:
        val = f"{bps / 1_000:5.1f}".replace(" ", FIG_SPACE)
        unit = "k" if style == "compact" else ("kb" if style == "short" else "kbit")
    else:
        val = f"{bps:5.1f}".replace(" ", FIG_SPACE)
        unit = "b" if style == "compact" else (FIG_SPACE + "b" if style == "short" else FIG_SPACE + "bit")
    return f"{val} {unit}"

def format_bytes_rate(bytes_per_sec, style="full"):
    try:
        Bps = float(bytes_per_sec)
    except (ValueError, TypeError):
        Bps = 0.0
    if Bps < 0:
        Bps = 0.0

    if Bps >= 1_099_511_627_776:
        val = f"{Bps / 1_099_511_627_776:5.1f}".replace(" ", FIG_SPACE)
        unit = "T" if style == "compact" else "TB"
    elif Bps >= 1_073_741_824:
        val = f"{Bps / 1_073_741_824:5.1f}".replace(" ", FIG_SPACE)
        unit = "G" if style == "compact" else "GB"
    elif Bps >= 1_048_576:
        val = f"{Bps / 1_048_576:5.1f}".replace(" ", FIG_SPACE)
        unit = "M" if style == "compact" else "MB"
    elif Bps >= 1024:
        val = f"{Bps / 1024:5.1f}".replace(" ", FIG_SPACE)
        unit = "K" if style == "compact" else "KB"
    else:
        val = f"{Bps:5.1f}".replace(" ", FIG_SPACE)
        unit = "B" if style == "compact" else (FIG_SPACE + "B")
    return f"{val} {unit}"

def format_uptime(timeticks):
    try:
        tt = int(timeticks)
    except (ValueError, TypeError):
        return ""
    if tt <= 0:
        return ""
    total_sec = tt // 100
    days = total_sec // 86400
    rem = total_sec % 86400
    hours = rem // 3600
    mins = (rem % 3600) // 60

    if days >= 2:
        return f"{days} Tagen, {hours:02d}:{mins:02d} Std."
    elif days == 1:
        return f"1 Tag, {hours:02d}:{mins:02d} Std."
    elif hours >= 1:
        return f"{hours:02d}:{mins:02d} Std."
    else:
        return f"{mins} Min."

def format_lancom_duration(dur_str):
    try:
        dur_str = str(dur_str).strip()
        if "D" in dur_str:
            days_part, time_part = dur_str.split("D")
            days = int(days_part.strip())
            parts = time_part.strip().split(":")
            hours = int(parts[0])
            mins = int(parts[1]) if len(parts) > 1 else 0
        elif ":" in dur_str:
            days = 0
            parts = dur_str.split(":")
            hours = int(parts[0])
            mins = int(parts[1]) if len(parts) > 1 else 0
        else:
            return dur_str
            
        if days >= 2:
            return f"seit {days} Tagen, {hours:02d}:{mins:02d} Std."
        elif days == 1:
            return f"seit 1 Tag, {hours:02d}:{mins:02d} Std."
        elif hours >= 1:
            return f"seit {hours:02d}:{mins:02d} Std."
        else:
            return f"seit {mins} Min."
    except Exception:
        return str(dur_str)

# --- IP-Klassifizierung & LANCOM WAN / QoS Peer-Details ---

def classify_ip(ip_str):
    if not ip_str:
        return {"ip": "", "is_cgnat": False, "type": ""}
    try:
        ip = ipaddress.ip_address(ip_str)
        if ip in ipaddress.ip_network("100.64.0.0/10"):
            return {"ip": ip_str, "is_cgnat": True, "type": "CGNAT (RFC 6598)"}
        elif ip.is_private:
            return {"ip": ip_str, "is_cgnat": True, "type": "CGNAT (Carrier-Private)"}
        elif ip.is_global:
            return {"ip": ip_str, "is_cgnat": False, "type": "Public IPv4"}
        return {"ip": ip_str, "is_cgnat": False, "type": "Other"}
    except Exception:
        return {"ip": ip_str, "is_cgnat": False, "type": ""}

def fetch_lancom_peer_details(host, community, version=1):
    peers = {}
    # 1. Active Table: Laufzeiten (1.3.6.1.4.1.2356.11.1.17.1)
    try:
        t17 = snmp_walk(host, community, "1.3.6.1.4.1.2356.11.1.17.1", version=version, max_reps=30, timeout=0.8)
        cols17 = {}
        p17 = "1.3.6.1.4.1.2356.11.1.17.1."
        for oid, val in t17.items():
            if oid.startswith(p17):
                parts = oid[len(p17):].split(".", 1)
                if len(parts) == 2:
                    c, rk = int(parts[0]), parts[1]
                    cols17.setdefault(rk, {})[c] = val
        for rk, row in cols17.items():
            p_name = row.get(2)
            dur = row.get(5)
            if p_name and dur:
                name_str = str(p_name).upper()
                peers.setdefault(name_str, {})["uptime"] = format_lancom_duration(str(dur))
    except Exception:
        pass

    # 2. WAN IP Table (1.3.6.1.4.1.2356.11.1.4.13.1.1)
    try:
        t13 = snmp_walk(host, community, "1.3.6.1.4.1.2356.11.1.4.13.1.1", version=version, max_reps=50, timeout=0.8)
        p13 = "1.3.6.1.4.1.2356.11.1.4.13.1.1."
        for oid, val in t13.items():
            if oid.startswith(p13):
                parts = oid[len(p13):].split(".")
                col = int(parts[0])
                peer_bytes = bytes([int(x) for x in parts[2:]])
                p_name = peer_bytes.decode("utf-8", errors="ignore").upper()
                entry = peers.setdefault(p_name, {})
                if col == 3 and isinstance(val, bytes) and len(val) == 4:
                    ip_str = ".".join(str(b) for b in val)
                    cl = classify_ip(ip_str)
                    entry["ip"] = ip_str
                    entry["is_cgnat"] = cl["is_cgnat"]
                    entry["ip_type"] = cl["type"]
                elif col in (6, 7) and isinstance(val, bytes) and len(val) == 4:
                    dns = ".".join(str(b) for b in val)
                    if dns != "0.0.0.0":
                        entry.setdefault("dns", []).append(dns)
    except Exception:
        pass

    # 3. QoS / Shaper Table (1.3.6.1.4.1.2356.11.1.4.46.1)
    try:
        t46 = snmp_walk(host, community, "1.3.6.1.4.1.2356.11.1.4.46.1", version=version, max_reps=50, timeout=0.8)
        p46 = "1.3.6.1.4.1.2356.11.1.4.46.1."
        for oid, val in t46.items():
            if oid.startswith(p46):
                parts = oid[len(p46):].split(".")
                col = int(parts[0])
                peer_bytes = bytes([int(x) for x in parts[2:]])
                p_name = peer_bytes.decode("utf-8", errors="ignore").upper()
                entry = peers.setdefault(p_name, {})
                if col == 2: entry["max_tx_kbit"] = val
                elif col == 3: entry["max_rx_kbit"] = val
                elif col == 8: entry["shaper_tx_kbit"] = val
                elif col == 9: entry["shaper_rx_kbit"] = val
    except Exception:
        pass

    return peers

# --- Lokale Schnittstellen-Erfassung (Linux /proc/net/dev) ---

def read_local_proc_net_dev():
    res = {}
    try:
        with open("/proc/net/dev", "r") as f:
            lines = f.readlines()
        for line in lines[2:]:
            if ":" not in line:
                continue
            iface_name, rest = line.split(":", 1)
            iface_name = iface_name.strip()
            parts = rest.split()
            rx_bytes = int(parts[0])
            tx_bytes = int(parts[8])
            res[iface_name] = {"rx_bytes": rx_bytes, "tx_bytes": tx_bytes}
    except Exception:
        pass
    return res

def get_local_uptime():
    try:
        with open("/proc/uptime", "r") as f:
            seconds = float(f.readline().split()[0])
            ticks = int(seconds * 100)
            return ticks, format_uptime(ticks)
    except Exception:
        return 0, ""

def discover_local_interfaces():
    devs = []
    base = '/sys/class/net'
    if not os.path.exists(base):
        return []
    for name in sorted(os.listdir(base)):
        if name == 'lo':
            continue
        oper = 'unknown'
        try:
            with open(f'{base}/{name}/operstate') as f:
                oper = f.read().strip()
        except: pass
        
        speed = 0
        try:
            with open(f'{base}/{name}/speed') as f:
                speed = int(f.read().strip())
        except: pass

        icon = 'network-wired-symbolic'
        label = name
        if name.startswith('wl') or 'wlan' in name or 'wifi' in name:
            icon = 'network-wireless-symbolic'
            label = f"WLAN ({name})"
        elif name.startswith('ww') or 'wwan' in name or 'lte' in name or '5g' in name:
            icon = 'network-cellular-signal-excellent-symbolic'
            label = f"5G ({name})"
        elif name.startswith('en') or name.startswith('eth'):
            icon = 'network-wired-symbolic'
            label = f"Ethernet ({name})"
        elif name.startswith('tun') or name.startswith('wg'):
            icon = 'network-vpn-symbolic'
            label = f"VPN ({name})"

        devs.append({
            'index': name,
            'name': label,
            'descr': f'Lokale Schnittstelle {name}',
            'alias': name,
            'display_name': label,
            'is_up': (oper == 'up'),
            'speed_mbps': float(speed) if speed > 0 else 0.0,
            'suggested_icon': icon
        })
    return devs

# --- Discovery (SNMP Walk) ---

def discover_interfaces(host, community, version_str="v2c"):
    if str(host).lower() in ["localhost", "local", "127.0.0.1"]:
        return {"status": "ok", "host": host, "discovered_interfaces": discover_local_interfaces()}

    version = 1 if version_str == "v2c" else 0
    descrs = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.2", version=version)
    names = snmp_walk(host, community, "1.3.6.1.2.1.31.1.1.1.1", version=version)
    aliases = snmp_walk(host, community, "1.3.6.1.2.1.31.1.1.1.18", version=version)
    oper_status = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.8", version=version)
    admin_status = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.7", version=version)
    speeds = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.5", version=version)
    
    ifaces = {}
    for oid, descr in descrs.items():
        idx = int(oid.split('.')[-1])
        op = oper_status.get(f"1.3.6.1.2.1.2.2.1.8.{idx}", 2)
        adm = admin_status.get(f"1.3.6.1.2.1.2.2.1.7.{idx}", 1)
        ifaces[idx] = {
            "index": idx,
            "descr": str(descr),
            "name": str(names.get(f"1.3.6.1.2.1.31.1.1.1.1.{idx}", descr)),
            "alias": str(aliases.get(f"1.3.6.1.2.1.31.1.1.1.18.{idx}", "")),
            "is_up": (op == 1),
            "speed_mbps": round((speeds.get(f"1.3.6.1.2.1.2.2.1.5.{idx}", 0) or 0) / 1_000_000, 1)
        }
        
    result = []
    for idx, iface in sorted(ifaces.items()):
        name_lower = iface["name"].lower()
        descr_lower = iface["descr"].lower()
        
        icon = "network-wired-symbolic"
        if any(k in name_lower or k in descr_lower for k in ["wwan", "5g", "lte", "mobil"]):
            icon = "network-cellular-signal-excellent-symbolic"
        elif any(k in name_lower or k in descr_lower for k in ["dsl", "ppp", "wan"]):
            icon = "network-wired-symbolic"
        elif any(k in name_lower or k in descr_lower for k in ["pon", "fiber", "glas"]):
            icon = "network-transmit-receive-symbolic"
        elif "wlan" in name_lower or "wifi" in name_lower:
            icon = "network-wireless-symbolic"
            
        display_label = iface["alias"] if iface["alias"] else iface["name"]
        if iface["descr"] and iface["descr"] != iface["name"]:
            display_label = f"{display_label} ({iface['descr']})"
            
        result.append({
            "index": idx,
            "name": iface["name"],
            "descr": iface["descr"],
            "alias": iface["alias"],
            "display_name": display_label,
            "is_up": iface["is_up"],
            "speed_mbps": iface["speed_mbps"],
            "suggested_icon": icon
        })
        
    return {"status": "ok", "host": host, "discovered_interfaces": result}

# --- Multi-Connection Polling Logic ---

def poll_connections(connections):
    now = time.time()
    
    prev_state = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                prev_state = json.load(f)
        except Exception:
            prev_state = {}
            
    prev_time = prev_state.get("timestamp", 0)
    dt = now - prev_time if prev_time > 0 else 0
    current_state_cache = {"timestamp": now, "counters": {}}
    
    conn_results = []
    
    for conn in connections:
        conn_id = conn.get("id", "conn_1")
        conn_name = conn.get("name", "Gateway")
        agg_name = conn.get("aggregated_name", "Load-Balancer Gesamt")
        host = conn.get("host", "192.0.2.1")
        community = conn.get("community", "public")
        version_str = conn.get("version", "v2c")
        version = 1 if version_str == "v2c" else 0
        ifaces = conn.get("interfaces", [])
        
        is_local = str(host).lower() in ["localhost", "local", "127.0.0.1"] or conn.get("is_local") or conn.get("type") == "local"

        total_rx_bps = 0.0
        total_tx_bps = 0.0
        total_rx_bytes_sec = 0.0
        total_tx_bytes_sec = 0.0
        iface_results = []

        if is_local:
            local_ticks, local_uptime_str = get_local_uptime()
            local_devs = read_local_proc_net_dev()
            is_online = True
            uptime_ticks = local_ticks
            uptime_str = local_uptime_str

            for iface in ifaces:
                idx = str(iface.get("index", iface.get("id", "")))
                dev_name = idx if idx in local_devs else str(iface.get("alias") or iface.get("id") or iface.get("name") or "").strip()
                if dev_name not in local_devs:
                    for d in local_devs:
                        if d in dev_name or dev_name in d or d in str(iface.get("name", "")) or d in str(iface.get("index", "")):
                            dev_name = d
                            break

                cache_key = f"{conn_id}:{idx}"
                is_up = False
                oper_path = f"/sys/class/net/{dev_name}/operstate"
                if os.path.exists(oper_path):
                    try:
                        with open(oper_path) as f:
                            is_up = (f.read().strip() == "up")
                    except: pass

                speed_mbps = 0.0
                speed_path = f"/sys/class/net/{dev_name}/speed"
                if os.path.exists(speed_path):
                    try:
                        with open(speed_path) as f:
                            s = int(f.read().strip())
                            if s > 0: speed_mbps = float(s)
                    except: pass

                in_raw = None
                out_raw = None
                if dev_name in local_devs:
                    in_raw = local_devs[dev_name]["rx_bytes"]
                    out_raw = local_devs[dev_name]["tx_bytes"]

                rx_bps = 0.0
                tx_bps = 0.0
                rx_bytes_sec = 0.0
                tx_bytes_sec = 0.0

                if in_raw is not None and out_raw is not None:
                    current_state_cache["counters"][cache_key] = {"in": in_raw, "out": out_raw}
                    if 0.5 <= dt <= 60.0 and cache_key in prev_state.get("counters", {}):
                        prev_in = prev_state["counters"][cache_key]["in"]
                        prev_out = prev_state["counters"][cache_key]["out"]
                        d_in = (in_raw - prev_in) & 0xFFFFFFFFFFFFFFFF
                        d_out = (out_raw - prev_out) & 0xFFFFFFFFFFFFFFFF
                        rx_bytes_sec = d_in / dt
                        tx_bytes_sec = d_out / dt
                        rx_bps = rx_bytes_sec * 8.0
                        tx_bps = tx_bytes_sec * 8.0

                if rx_bps > 50 or tx_bps > 50:
                    is_up = True

                if is_up or rx_bps > 0 or tx_bps > 0:
                    total_rx_bps += rx_bps
                    total_tx_bps += tx_bps
                    total_rx_bytes_sec += rx_bytes_sec
                    total_tx_bytes_sec += tx_bytes_sec

                iface_results.append({
                    "id": iface.get("id", str(idx)),
                    "name": iface.get("name", f"Interface {idx}"),
                    "index": idx,
                    "icon": iface.get("icon", "network-wired-symbolic"),
                    "show_graph": iface.get("show_graph", True),
                    "is_up": is_up,
                    "status_str": "Online" if is_up else "Offline",
                    "uptime_str": f"seit {uptime_str}" if (is_up and uptime_str) else "",
                    "external_ip": "",
                    "is_cgnat": False,
                    "ip_type": "Lokal",
                    "dns_servers": [],
                    "sync_rx_kbit": round(speed_mbps * 1000) if speed_mbps > 0 else 0,
                    "sync_tx_kbit": round(speed_mbps * 1000) if speed_mbps > 0 else 0,
                    "sync_formatted": f"Sync: {speed_mbps:.1f} Mbit" if speed_mbps > 0 else "",
                    "qos_rx_kbit": 0,
                    "qos_tx_kbit": 0,
                    "qos_formatted": "",
                    "speed_mbps": speed_mbps,
                    "rx_bps": round(rx_bps),
                    "tx_bps": round(tx_bps),
                    "rx_formatted": format_rate(rx_bps, "full"),
                    "tx_formatted": format_rate(tx_bps, "full"),
                    "rx_bytes_formatted": format_bytes_rate(rx_bytes_sec, "full"),
                    "tx_bytes_formatted": format_bytes_rate(tx_bytes_sec, "full"),
                    "rx_compact": format_rate(rx_bps, "compact"),
                    "tx_compact": format_rate(tx_bps, "compact"),
                    "rx_bytes_compact": format_bytes_rate(rx_bytes_sec, "compact"),
                    "tx_bytes_compact": format_bytes_rate(tx_bytes_sec, "compact"),
                    "rx_short": format_rate(rx_bps, "short"),
                    "tx_short": format_rate(tx_bps, "short"),
                    "rx_bytes_short": format_bytes_rate(rx_bytes_sec, "short"),
                    "tx_bytes_short": format_bytes_rate(tx_bytes_sec, "short")
                })
        else:
            # --- SNMP-basiertes Polling ---
            oids_to_query = ["1.3.6.1.2.1.1.3.0"]
            for iface in ifaces:
                idx = iface["index"]
                if version == 1:
                    oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.6.{idx}")
                    oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.10.{idx}")
                else:
                    oids_to_query.append(f"1.3.6.1.2.1.2.2.1.10.{idx}")
                    oids_to_query.append(f"1.3.6.1.2.1.2.2.1.16.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.2.2.1.8.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.2.2.1.7.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.2.2.1.9.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.2.2.1.5.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.15.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.18.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.1.{idx}")
                oids_to_query.append(f"1.3.6.1.2.1.2.2.1.2.{idx}")
                
            snmp_data = snmp_get_multiple(host, community, oids_to_query, version=version)
            is_online = bool(snmp_data)

            uptime_ticks = snmp_data.get("1.3.6.1.2.1.1.3.0")
            uptime_str = format_uptime(uptime_ticks) if uptime_ticks else ""

            # Lancom Verbindungs-Laufzeiten, WAN-IPs & QoS-Shaper abrufen
            lancom_peers = {}
            if is_online:
                lancom_peers = fetch_lancom_peer_details(host, community, version=version)
            used_peers = set()
        
            for iface in ifaces:
                idx = iface["index"]
                cache_key = f"{conn_id}:{idx}"
                if version == 1:
                    in_oid = f"1.3.6.1.2.1.31.1.1.1.6.{idx}"
                    out_oid = f"1.3.6.1.2.1.31.1.1.1.10.{idx}"
                else:
                    in_oid = f"1.3.6.1.2.1.2.2.1.10.{idx}"
                    out_oid = f"1.3.6.1.2.1.2.2.1.16.{idx}"
                status_oid = f"1.3.6.1.2.1.2.2.1.8.{idx}"
                admin_oid = f"1.3.6.1.2.1.2.2.1.7.{idx}"
                
                in_raw = snmp_data.get(in_oid)
                out_raw = snmp_data.get(out_oid)
                oper_raw = snmp_data.get(status_oid, 2)
                admin_raw = snmp_data.get(admin_oid, 1)

                rx_bps = 0.0
                tx_bps = 0.0
                rx_bytes_sec = 0.0
                tx_bytes_sec = 0.0
                
                if in_raw is not None and out_raw is not None:
                    current_state_cache["counters"][cache_key] = {"in": in_raw, "out": out_raw}
                    if 0.5 <= dt <= 60.0 and cache_key in prev_state.get("counters", {}):
                        prev_in = prev_state["counters"][cache_key]["in"]
                        prev_out = prev_state["counters"][cache_key]["out"]
                        mask = 0xFFFFFFFFFFFFFFFF if version == 1 else 0xFFFFFFFF
                        d_in = (in_raw - prev_in) & mask
                        d_out = (out_raw - prev_out) & mask
                        rx_bytes_sec = d_in / dt
                        tx_bytes_sec = d_out / dt
                        rx_bps = rx_bytes_sec * 8.0
                        tx_bps = tx_bytes_sec * 8.0

                # Leitungs-Laufzeit, WAN-IP, CGNAT, Sync & QoS ermitteln
                iface_uptime_str = ""
                matched_peer = None
                matched_peer_name = None
                alias_snmp = str(snmp_data.get(f"1.3.6.1.2.1.31.1.1.1.18.{idx}", "")).upper()
                name_snmp = str(snmp_data.get(f"1.3.6.1.2.1.31.1.1.1.1.{idx}", "")).upper()
                descr_snmp = str(snmp_data.get(f"1.3.6.1.2.1.2.2.1.2.{idx}", "")).upper()
                user_name = str(iface.get("name", "")).upper()
                user_id = str(iface.get("id", "")).upper()
                tokens = [alias_snmp, name_snmp, descr_snmp, user_name, user_id]

                # 1. Lancom Peer Match nach Name (nur unvergebene Peers)
                for p_name, p_data in lancom_peers.items():
                    if p_name in used_peers:
                        continue
                    if any(p_name and (p_name in tok or tok in p_name) for tok in tokens if tok):
                        matched_peer = p_data
                        matched_peer_name = p_name
                        break
                
                # Fallback bei Single-Interface Routern mit 1 WAN-Peer (z.B. Standort / Standort)
                if not matched_peer and len(lancom_peers) == 1 and len(ifaces) == 1:
                    first_k, first_v = next(iter(lancom_peers.items()))
                    if first_k not in used_peers:
                        matched_peer = first_v
                        matched_peer_name = first_k
                elif not matched_peer and "INTERNET" in lancom_peers and "INTERNET" not in used_peers:
                    # "INTERNET" nur zuweisen, wenn Schnittstelle explizit DSL/VDSL/WAN ist (nicht generic Glas/Fiber)
                    if any(k in tok for tok in tokens for k in ["DSL", "VDSL", "INTERNET", "WAN"]):
                        matched_peer = lancom_peers["INTERNET"]
                        matched_peer_name = "INTERNET"

                if matched_peer_name:
                    used_peers.add(matched_peer_name)

                # Online-Erkennung:
                # 1. Standard ifOperStatus == 1 (up) -> Online
                # 2. Reales Datenaufkommen (rx_bps > 50 oder tx_bps > 50) -> Online (z.B. WAN-Bridges wie XDSL-1)
                # 3. Wenn ein zugeordneter aktiver Lancom-Peer mit echter Uptime/IP vorliegt -> Online
                has_active_peer = bool(matched_peer and (matched_peer.get("uptime") or matched_peer.get("ip")))
                is_up = (oper_raw == 1) or (rx_bps > 50 or tx_bps > 50) or has_active_peer

                ext_ip = ""
                is_cgnat = False
                ip_type = ""
                dns_servers = []
                sync_rx = 0
                sync_tx = 0
                shaper_rx = 0
                shaper_tx = 0
                sync_str = ""
                qos_str = ""

                speed_raw = snmp_data.get(f"1.3.6.1.2.1.2.2.1.5.{idx}", 0) or 0
                high_speed_raw = snmp_data.get(f"1.3.6.1.2.1.31.1.1.1.15.{idx}", 0) or 0
                speed_mbps = float(high_speed_raw) if high_speed_raw > 0 else round(speed_raw / 1_000_000.0, 1)

                if is_up:
                    if matched_peer:
                        iface_uptime_str = matched_peer.get("uptime", "")
                        ext_ip = matched_peer.get("ip", "")
                        is_cgnat = matched_peer.get("is_cgnat", False)
                        ip_type = matched_peer.get("ip_type", "")
                        dns_servers = matched_peer.get("dns", [])
                        sync_rx = matched_peer.get("max_rx_kbit", 0)
                        sync_tx = matched_peer.get("max_tx_kbit", 0)
                        shaper_rx = matched_peer.get("shaper_rx_kbit", 0)
                        shaper_tx = matched_peer.get("shaper_tx_kbit", 0)

                    if sync_rx > 0 and sync_tx > 0:
                        sync_str = f"↓ {sync_rx / 1000.0:.1f} Mbit · ↑ {sync_tx / 1000.0:.1f} Mbit"
                    elif speed_mbps > 0:
                        sync_str = f"Sync: {speed_mbps:.1f} Mbit"

                    if shaper_rx > 0 and shaper_tx > 0:
                        qos_str = f"↓ {shaper_rx / 1000.0:.1f} Mbit · ↑ {shaper_tx / 1000.0:.1f} Mbit"

                    # 2. Standard MIB-2 Fallback via ifLastChange oder sysUpTime
                    if not iface_uptime_str and uptime_ticks:
                        last_chg = snmp_data.get(f"1.3.6.1.2.1.2.2.1.9.{idx}", 0)
                        if last_chg and last_chg > 0 and uptime_ticks > last_chg:
                            diff = uptime_ticks - last_chg
                            iface_uptime_str = f"seit {format_uptime(diff)}"
                        elif uptime_str:
                            iface_uptime_str = f"seit {uptime_str}"
                else:
                    iface_uptime_str = ""
                        
                if is_up or rx_bps > 0 or tx_bps > 0:
                    total_rx_bps += rx_bps
                    total_tx_bps += tx_bps
                    total_rx_bytes_sec += rx_bytes_sec
                    total_tx_bytes_sec += tx_bytes_sec
                    
                iface_results.append({
                    "id": iface.get("id", str(idx)),
                    "name": iface.get("name", f"Interface {idx}"),
                    "index": idx,
                    "icon": iface.get("icon", "network-wired-symbolic"),
                    "show_graph": iface.get("show_graph", True),
                    "is_up": is_up,
                    "status_str": "Online" if is_up else "Offline",
                    "uptime_str": iface_uptime_str,
                    "external_ip": ext_ip,
                    "is_cgnat": is_cgnat,
                    "ip_type": ip_type,
                    "dns_servers": dns_servers,
                    "sync_rx_kbit": sync_rx,
                    "sync_tx_kbit": sync_tx,
                    "sync_formatted": sync_str,
                    "qos_rx_kbit": shaper_rx,
                    "qos_tx_kbit": shaper_tx,
                    "qos_formatted": qos_str,
                    "speed_mbps": speed_mbps,
                    "rx_bps": round(rx_bps),
                    "tx_bps": round(tx_bps),
                    "rx_formatted": format_rate(rx_bps, "full"),
                    "tx_formatted": format_rate(tx_bps, "full"),
                    "rx_bytes_formatted": format_bytes_rate(rx_bytes_sec, "full"),
                    "tx_bytes_formatted": format_bytes_rate(tx_bytes_sec, "full"),
                    "rx_compact": format_rate(rx_bps, "compact"),
                    "tx_compact": format_rate(tx_bps, "compact"),
                    "rx_bytes_compact": format_bytes_rate(rx_bytes_sec, "compact"),
                    "tx_bytes_compact": format_bytes_rate(tx_bytes_sec, "compact"),
                    "rx_short": format_rate(rx_bps, "short"),
                    "tx_short": format_rate(tx_bps, "short"),
                    "rx_bytes_short": format_bytes_rate(rx_bytes_sec, "short"),
                    "tx_bytes_short": format_bytes_rate(tx_bytes_sec, "short")
                })
            
        show_agg = conn.get("show_aggregated")
        if show_agg is None:
            show_agg = (len(ifaces) > 1)

        conn_results.append({
            "id": conn_id,
            "name": conn_name,
            "host": host,
            "aggregated_name": agg_name,
            "show_aggregated": show_agg,
            "is_online": is_online,
            "uptime_ticks": uptime_ticks,
            "uptime_str": uptime_str,
            "uptime_formatted": f"Online seit {uptime_str}" if uptime_str else "",
            "total": {
                "rx_bps": round(total_rx_bps),
                "tx_bps": round(total_tx_bps),
                "rx_formatted": format_rate(total_rx_bps, "full"),
                "tx_formatted": format_rate(total_tx_bps, "full"),
                "rx_bytes_formatted": format_bytes_rate(total_rx_bytes_sec, "full"),
                "tx_bytes_formatted": format_bytes_rate(total_tx_bytes_sec, "full"),
                "rx_compact": format_rate(total_rx_bps, "compact"),
                "tx_compact": format_rate(total_tx_bps, "compact"),
                "rx_bytes_compact": format_bytes_rate(total_rx_bytes_sec, "compact"),
                "tx_bytes_compact": format_bytes_rate(total_tx_bytes_sec, "compact"),
                "rx_short": format_rate(total_rx_bps, "short"),
                "tx_short": format_rate(total_tx_bps, "short"),
                "rx_bytes_short": format_bytes_rate(total_rx_bytes_sec, "short"),
                "tx_bytes_short": format_bytes_rate(total_tx_bytes_sec, "short")
            },
            "interfaces": iface_results
        })
        
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(current_state_cache, f)
    except Exception:
        pass
        
    # Rückwärtskompatibles Format bereitstellen
    first_conn = conn_results[0] if conn_results else {}
    return {
        "status": "ok" if any(c["is_online"] for c in conn_results) else "offline",
        "timestamp": now,
        "connections": conn_results,
        "host": first_conn.get("host", ""),
        "load_balancer": {
            "name": first_conn.get("aggregated_name", "Load-Balancer Gesamt"),
            "total": first_conn.get("total", {}),
            "interfaces": first_conn.get("interfaces", [])
        }
    }

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--walk":
        host = sys.argv[2] if len(sys.argv) > 2 else "192.0.2.1"
        comm = sys.argv[3] if len(sys.argv) > 3 else "public"
        ver = sys.argv[4] if len(sys.argv) > 4 else "v2c"
        result = discover_interfaces(host, comm, ver)
        print(json.dumps(result, indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == "--connections":
        conn_json_str = sys.argv[2] if len(sys.argv) > 2 else "[]"
        conns = json.loads(conn_json_str)
        result = poll_connections(conns)
        print(json.dumps(result, indent=2))
    else:
        # Fallback auf Einzel-Polling
        host = sys.argv[1] if len(sys.argv) > 1 else "192.0.2.1"
        comm = sys.argv[2] if len(sys.argv) > 2 else "public"
        ver = sys.argv[3] if len(sys.argv) > 3 else "v2c"
        ifaces_str = sys.argv[4] if len(sys.argv) > 4 else "[]"
        ifaces = json.loads(ifaces_str) if ifaces_str else []
        conns = [{
            "id": "conn_1",
            "name": "Gateway",
            "aggregated_name": "Load-Balancer Gesamt",
            "host": host,
            "community": comm,
            "version": ver,
            "interfaces": ifaces
        }]
        result = poll_connections(conns)
        print(json.dumps(result, indent=2))
