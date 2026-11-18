/**
 * Builds an EMVCo-structured Bangla QR payload string containing merchant account,
 * BDT currency code (050), transaction amount, and order reference.
 */
export function buildBanglaQrString(params: {
  merchantName: string;
  accountNumber: string;
  amountBdt: number;
  referenceCode: string;
}): string {
  const tlv = (tag: string, value: string): string => {
    const len = String(value.length).padStart(2, '0');
    return `${tag}${len}${value}`;
  };

  const cleanName = params.merchantName.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 25).toUpperCase() || 'MERCHANT';
  const cleanAmt = params.amountBdt.toFixed(2);
  const merchantInfo = tlv('00', 'BD.COM.BANGLAQR') + tlv('01', params.accountNumber.slice(0, 20));
  const addlData = tlv('05', params.referenceCode.slice(0, 20));

  const body =
    tlv('00', '01') +
    tlv('01', '12') + // Dynamic QR
    tlv('26', merchantInfo) +
    tlv('52', '5411') +
    tlv('53', '050') + // BDT ISO 4217 numeric
    tlv('54', cleanAmt) +
    tlv('58', 'BD') +
    tlv('59', cleanName) +
    tlv('60', 'DHAKA') +
    tlv('62', addlData) +
    '6304';

  // CRC-16/CCITT-FALSE
  let crc = 0xffff;
  for (let i = 0; i < body.length; i++) {
    crc ^= body.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return body + crc.toString(16).toUpperCase().padStart(4, '0');
}
