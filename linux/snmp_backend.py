#!/usr/bin/env python3
"""
snmp_backend.py - Robuster, asynchroner SNMP-Metrik-Poller & Discovery-Engine für snmpbar.
Unterstützt:
- Polling beliebiger konfigurierter Interfaces
- Discovery aller Interfaces eines Routers via --walk (Lancom, FritzBox, Cisco, MikroTik etc.)
- Exakte Ratenberechnung mit 64-Bit Counter64 und mathematischer Aggregation
"""

import sys
import os
import json
import time
import socket
import struct

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

def snmp_get_multiple(host, community, oids, version=1, timeout=1.5):
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

def snmp_walk(host, community, root_oid, version=1, max_reps=500, timeout=1.5):
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

# --- Formatierungs-Funktionen (Stabile Breite mit 1 Dezimalstelle) ---

def format_rate(bits_per_sec):
    """Gibt Raten mit fester Dezimalstelle aus, damit die Breite nicht springt."""
    if bits_per_sec >= 1_000_000_000:
        return f"{bits_per_sec / 1_000_000_000:5.1f} Gbit/s"
    elif bits_per_sec >= 1_000_000:
        return f"{bits_per_sec / 1_000_000:5.1f} Mbit/s"
    elif bits_per_sec >= 1_000:
        return f"{bits_per_sec / 1_000:5.1f} kbit/s"
    else:
        return f"{bits_per_sec:5.1f} bit/s"

def format_bytes_rate(bytes_per_sec):
    if bytes_per_sec >= 1_073_741_824:
        return f"{bytes_per_sec / 1_073_741_824:5.1f} GB/s"
    elif bytes_per_sec >= 1_048_576:
        return f"{bytes_per_sec / 1_048_576:5.1f} MB/s"
    elif bytes_per_sec >= 1024:
        return f"{bytes_per_sec / 1024:5.1f} KB/s"
    else:
        return f"{bytes_per_sec:5.1f} B/s"

# --- Discovery-Funktion (SNMP Walk für Interfaces) ---

def discover_interfaces(host, community, version_str="v2c"):
    version = 1 if version_str == "v2c" else 0
    descrs = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.2", version=version)
    names = snmp_walk(host, community, "1.3.6.1.2.1.31.1.1.1.1", version=version)
    aliases = snmp_walk(host, community, "1.3.6.1.2.1.31.1.1.1.18", version=version)
    oper_status = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.8", version=version)
    speeds = snmp_walk(host, community, "1.3.6.1.2.1.2.2.1.5", version=version)
    
    ifaces = {}
    for oid, descr in descrs.items():
        idx = int(oid.split('.')[-1])
        ifaces[idx] = {
            "index": idx,
            "descr": str(descr),
            "name": str(names.get(f"1.3.6.1.2.1.31.1.1.1.1.{idx}", descr)),
            "alias": str(aliases.get(f"1.3.6.1.2.1.31.1.1.1.18.{idx}", "")),
            "is_up": (oper_status.get(f"1.3.6.1.2.1.2.2.1.8.{idx}", 2) == 1),
            "speed_mbps": round((speeds.get(f"1.3.6.1.2.1.2.2.1.5.{idx}", 0) or 0) / 1_000_000, 1)
        }
        
    # Relevante Interfaces filtern (UP oder bekannte Bezeichnungen)
    result = []
    for idx, iface in sorted(ifaces.items()):
        name_lower = iface["name"].lower()
        descr_lower = iface["descr"].lower()
        alias_lower = iface["alias"].lower()
        
        # Geeignetes Ubuntu-Symbolic-Icon vorschlagen
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

# --- Polling-Funktion ---

def poll_metrics(host="192.0.2.1", community="public", version_str="v2c", ifaces_config=None):
    version = 1 if version_str == "v2c" else 0
    now = time.time()
    
    # Standard-Interfaces falls keine übergeben
    if not ifaces_config:
        ifaces_config = [
            {"id": "vdsl", "name": "VDSL (INTERNET)", "index": 65, "icon": "network-wired-symbolic", "show_in_bar": False},
            {"id": "wwan", "name": "5G (INET_WWAN)", "index": 93, "icon": "network-cellular-signal-excellent-symbolic", "show_in_bar": False},
            {"id": "gpon", "name": "Glasfaser (GPON)", "index": 400010, "icon": "network-transmit-receive-symbolic", "show_in_bar": False},
        ]
        
    oids_to_query = []
    for iface in ifaces_config:
        idx = iface["index"]
        if version == 1: # v2c 64-bit HC
            oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.6.{idx}")
            oids_to_query.append(f"1.3.6.1.2.1.31.1.1.1.10.{idx}")
        else: # v1 32-bit
            oids_to_query.append(f"1.3.6.1.2.1.2.2.1.10.{idx}")
            oids_to_query.append(f"1.3.6.1.2.1.2.2.1.16.{idx}")
        oids_to_query.append(f"1.3.6.1.2.1.2.2.1.8.{idx}")
        
    snmp_data = snmp_get_multiple(host, community, oids_to_query, version=version)
    is_online = bool(snmp_data)
    
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
    
    iface_results = []
    total_rx_bps = 0.0
    total_tx_bps = 0.0
    total_rx_bytes_sec = 0.0
    total_tx_bytes_sec = 0.0
    
    for iface in ifaces_config:
        idx = iface["index"]
        if version == 1:
            in_oid = f"1.3.6.1.2.1.31.1.1.1.6.{idx}"
            out_oid = f"1.3.6.1.2.1.31.1.1.1.10.{idx}"
        else:
            in_oid = f"1.3.6.1.2.1.2.2.1.10.{idx}"
            out_oid = f"1.3.6.1.2.1.2.2.1.16.{idx}"
        status_oid = f"1.3.6.1.2.1.2.2.1.8.{idx}"
        
        in_raw = snmp_data.get(in_oid)
        out_raw = snmp_data.get(out_oid)
        oper_raw = snmp_data.get(status_oid, 2)
        
        is_up = (oper_raw == 1)
        rx_bps = 0.0
        tx_bps = 0.0
        rx_bytes_sec = 0.0
        tx_bytes_sec = 0.0
        
        if in_raw is not None and out_raw is not None:
            current_state_cache["counters"][str(idx)] = {"in": in_raw, "out": out_raw}
            if 0.5 <= dt <= 60.0 and str(idx) in prev_state.get("counters", {}):
                prev_in = prev_state["counters"][str(idx)]["in"]
                prev_out = prev_state["counters"][str(idx)]["out"]
                mask = 0xFFFFFFFFFFFFFFFF if version == 1 else 0xFFFFFFFF
                d_in = (in_raw - prev_in) & mask
                d_out = (out_raw - prev_out) & mask
                rx_bytes_sec = d_in / dt
                tx_bytes_sec = d_out / dt
                rx_bps = rx_bytes_sec * 8.0
                tx_bps = tx_bytes_sec * 8.0
                
        if is_up:
            total_rx_bps += rx_bps
            total_tx_bps += tx_bps
            total_rx_bytes_sec += rx_bytes_sec
            total_tx_bytes_sec += tx_bytes_sec
            
        iface_results.append({
            "id": iface.get("id", str(idx)),
            "name": iface.get("name", f"Interface {idx}"),
            "index": idx,
            "icon": iface.get("icon", "network-wired-symbolic"),
            "show_in_bar": iface.get("show_in_bar", False),
            "is_up": is_up,
            "status_str": "UP" if is_up else "DOWN",
            "rx_bps": round(rx_bps),
            "tx_bps": round(tx_bps),
            "rx_formatted": format_rate(rx_bps),
            "tx_formatted": format_rate(tx_bps),
            "rx_bytes_formatted": format_bytes_rate(rx_bytes_sec),
            "tx_bytes_formatted": format_bytes_rate(tx_bytes_sec)
        })
        
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(current_state_cache, f)
    except Exception:
        pass
        
    return {
        "status": "ok" if is_online else "offline",
        "timestamp": now,
        "host": host,
        "load_balancer": {
            "name": "WIZ_LOADBAL",
            "total": {
                "rx_bps": round(total_rx_bps),
                "tx_bps": round(total_tx_bps),
                "rx_formatted": format_rate(total_rx_bps),
                "tx_formatted": format_rate(total_tx_bps),
                "rx_bytes_formatted": format_bytes_rate(total_rx_bytes_sec),
                "tx_bytes_formatted": format_bytes_rate(total_tx_bytes_sec)
            },
            "interfaces": iface_results
        }
    }

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--walk":
        host = sys.argv[2] if len(sys.argv) > 2 else "192.0.2.1"
        comm = sys.argv[3] if len(sys.argv) > 3 else "public"
        ver = sys.argv[4] if len(sys.argv) > 4 else "v2c"
        result = discover_interfaces(host, comm, ver)
        print(json.dumps(result, indent=2))
    else:
        host = sys.argv[1] if len(sys.argv) > 1 else "192.0.2.1"
        comm = sys.argv[2] if len(sys.argv) > 2 else "public"
        ver = sys.argv[3] if len(sys.argv) > 3 else "v2c"
        ifaces_json_str = sys.argv[4] if len(sys.argv) > 4 else None
        ifaces_cfg = json.loads(ifaces_json_str) if ifaces_json_str else None
        
        result = poll_metrics(host, comm, ver, ifaces_cfg)
        print(json.dumps(result, indent=2))
