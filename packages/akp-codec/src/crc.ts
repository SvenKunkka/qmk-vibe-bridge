/**
 * CRC-8/SMBUS and CRC-16/CCITT-FALSE implementations (MSB-first).
 *
 *  - CRC-8/SMBUS   : poly 0x07, init 0x00, check("123456789") = 0xF4
 *  - CRC-16/CCITT  : poly 0x1021, init 0xFFFF, check("123456789") = 0x29B1
 *
 * Firmware mirrors (must stay bit-for-bit identical):
 *   firmware/qmk/modules/ai_console/akp_crc.h
 *   firmware/zmk/ai-agent-console/src/akp_crc.h
 */

export function crc8(data: Uint8Array, init = 0x00): number {
  let crc = init & 0xff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

export function crc16(data: Uint8Array, init = 0xffff): number {
  let crc = init & 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] & 0xff) << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}
