import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMfsNotification, registerDynamicBankTemplates } from '../index.ts';

test('bKash Personal & Merchant Payment parsing (TrxID, amount, sender, receiver, time)', () => {
  const merchantRes = parseMfsNotification({
    packageName: 'com.bkash.merchant',
    body: 'You have received payment Tk 2,450.00 from 01755112233 to 01711002233. Fee Tk 0.00. Balance Tk 42,150.00. TrxID BKH9X4M21Q at 17/11/2026 23:40.',
  });
  assert.equal(merchantRes.provider, 'BKASH');
  assert.equal(merchantRes.parseStatus, 'PARSED');
  assert.equal(merchantRes.accountMode, 'MERCHANT');
  assert.equal(merchantRes.amountBdt, 2450);
  assert.equal(merchantRes.trxId, 'BKH9X4M21Q');
  assert.equal(merchantRes.senderPhone, '01755112233');
  assert.equal(merchantRes.receiverAccount, '01711002233');
  assert.equal(merchantRes.transactionTime, '17/11/2026 23:40');

  const personalRes = parseMfsNotification({
    packageName: 'com.bKash.customerapp',
    deviceTimestampMs: 1794958800000,
    body: 'You have received Tk 950.00 from 01799887766. Fee Tk 0.00. Balance Tk 3,200.00. TrxID BKH7P11Q9Z.',
  });
  assert.equal(personalRes.provider, 'BKASH');
  assert.equal(personalRes.accountMode, 'PERSONAL');
  assert.equal(personalRes.amountBdt, 950);
  assert.equal(personalRes.trxId, 'BKH7P11Q9Z');
  assert.ok(personalRes.transactionTime);
});

test('Nagad Personal & Merchant Money Received parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.konasl.nagad',
    body: 'Money Received. Amount: Tk 4800.00 Sender: 01812334455 Ref: DC98409. TxnID: 71NGD8842K. Balance: Tk 29,400.00 on 17/11/2026 14:15',
  });
  assert.equal(res.provider, 'NAGAD');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.accountMode, 'PERSONAL');
  assert.equal(res.amountBdt, 4800);
  assert.equal(res.trxId, '71NGD8842K');
  assert.equal(res.senderPhone, '01812334455');
  assert.equal(res.reference, 'DC98409');
  assert.equal(res.transactionTime, '17/11/2026 14:15');
});

test('DBBL Rocket Cash-In & Merchant Pay SMS parsing (with sms:16216 fallback)', () => {
  const res = parseMfsNotification({
    packageName: 'sms:16216',
    body: 'Tk1,500.00 received from A/C 01688990011 to A/C 019120077889 Fee: Tk0.00 TxnId: RKT99201122. Balance: Tk18,900.00 Date: 17-11-2026 10:05 AM',
  });
  assert.equal(res.provider, 'ROCKET');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.amountBdt, 1500);
  assert.equal(res.trxId, 'RKT99201122');
  assert.equal(res.senderPhone, '01688990011');
  assert.equal(res.receiverAccount, '019120077889');
  assert.equal(res.transactionTime, '17-11-2026 10:05 AM');
});

test('UCB Upay Customer (bd.com.upay.customer) & Merchant parsing', () => {
  const customerAppRes = parseMfsNotification({
    packageName: 'bd.com.upay.customer',
    body: 'You have received Tk 1,200.00 from 01722003344. TrxID UPAY771299. Balance Tk 8,450.00 at 17/11/2026 16:45.',
  });
  assert.equal(customerAppRes.provider, 'UPAY');
  assert.equal(customerAppRes.parseStatus, 'PARSED');
  assert.equal(customerAppRes.accountMode, 'PERSONAL');
  assert.equal(customerAppRes.amountBdt, 1200);
  assert.equal(customerAppRes.trxId, 'UPAY771299');
  assert.equal(customerAppRes.senderPhone, '01722003344');
  assert.equal(customerAppRes.transactionTime, '17/11/2026 16:45');

  const merchantRes = parseMfsNotification({
    packageName: 'bd.com.upay.merchant',
    body: 'Received payment Tk 2,300.00 from 01855667788 to 01722003344. TrxID UPAYM88210. Balance Tk 15,000.00.',
  });
  assert.equal(merchantRes.provider, 'UPAY');
  assert.equal(merchantRes.accountMode, 'MERCHANT');
  assert.equal(merchantRes.amountBdt, 2300);
  assert.equal(merchantRes.trxId, 'UPAYM88210');
  assert.equal(merchantRes.receiverAccount, '01722003344');
});

test('Islami Bank CellFin notification & SMS parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.ibbl.cellfin',
    senderHeader: 'IBBL',
    deviceTimestampMs: 1794958800000,
    body: 'IBBL CellFin: Your A/C 2050***318 credited BDT 1,950.00 via CellFin QR from 01744556677. TrxID: CFN4488210. Bal BDT 51,400.00 on 17-Nov-26 18:10',
  });
  assert.equal(res.provider, 'CELLFIN');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.amountBdt, 1950);
  assert.equal(res.trxId, 'CFN4488210');
  assert.equal(res.senderPhone, '01744556677');
  assert.equal(res.receiverAccount, '2050***318');
  assert.equal(res.transactionTime, '17-Nov-26 18:10');
});

test('Bangla QR City Bank & BRAC Bank NPSB/QR parsing (with sms:CITYBANK fallback)', () => {
  const cityRes = parseMfsNotification({
    packageName: 'sms:CITYBANK',
    body: 'Your A/C ***8841 credited by BDT 3,500.00 via BanglaQR from 01711223344 on 17/11/2026 19:00. Ref: CBQR901288. Bal: BDT 145,200.00',
  });
  assert.equal(cityRes.provider, 'BANGLA_QR');
  assert.equal(cityRes.parseStatus, 'PARSED');
  assert.equal(cityRes.amountBdt, 3500);
  assert.equal(cityRes.trxId, 'CBQR901288');
  assert.equal(cityRes.receiverAccount, '***8841');
  assert.equal(cityRes.bankName, 'The City Bank PLC');
  assert.equal(cityRes.transactionTime, '17/11/2026 19:00');

  const bracRes = parseMfsNotification({
    packageName: 'com.google.android.apps.messaging',
    senderHeader: 'BRACBANK',
    body: 'BRAC Bank Alert: A/C 1501***902 credited with Tk 4,200.00 on 17-Nov-26. Desc: NPSB/QR-BRAC99201. Avl Bal Tk 92,100.00',
  });
  assert.equal(bracRes.provider, 'BANGLA_QR');
  assert.equal(bracRes.parseStatus, 'PARSED');
  assert.equal(bracRes.amountBdt, 4200);
  assert.equal(bracRes.trxId, 'BRAC99201');
  assert.equal(bracRes.bankName, 'BRAC Bank PLC');
  assert.equal(bracRes.transactionTime, '17-Nov-26');
});

test('Bank SMS Extensible Dynamic Template parsing', () => {
  registerDynamicBankTemplates([
    {
      bank_name: 'Pubali Bank PLC',
      sender_id: 'PUBALIBANK',
      amount_regex: '(?:BDT|Tk)\\s*([\\d,]+(?:\\.\\d{1,2})?)',
      trx_regex: '(?:Ref|TrxID)\\s*[:#-]?\\s*([A-Z0-9]{6,16})',
      account_regex: 'A\\/C\\s*([*\\d]{4,16})',
    },
  ]);

  const res = parseMfsNotification({
    packageName: 'sms:PUBALIBANK',
    body: 'A/C ***9911 credited with BDT 7,250.00 on 2026-11-17 14:22. Ref: PBL881209.',
  });
  assert.equal(res.provider, 'BANK_SMS');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.bankName, 'Pubali Bank PLC');
  assert.equal(res.amountBdt, 7250);
  assert.equal(res.trxId, 'PBL881209');
  assert.equal(res.receiverAccount, '***9911');
  assert.equal(res.transactionTime, '2026-11-17 14:22');
});

test('Security filter blocks OTP/PIN messages and ignores outgoing debits', () => {
  const otpRes = parseMfsNotification({
    packageName: 'com.bKash.customerapp',
    body: 'Your bKash One Time Password OTP is 849201. Never share your PIN.',
  });
  assert.equal(otpRes.parseStatus, 'IGNORED_SECURITY');
  assert.equal(otpRes.amountBdt, null);
  assert.equal(otpRes.trxId, null);

  const debitRes = parseMfsNotification({
    packageName: 'com.bKash.customerapp',
    body: 'Cash Out Tk 1,000.00 to 01711223344 successful. TrxID BKHDEBIT99.',
  });
  assert.equal(debitRes.parseStatus, 'UNPARSED');
  assert.equal(debitRes.txType, 'OUTGOING_DEBIT');

  const unknownRes = parseMfsNotification({
    packageName: 'com.unknown.bank',
    body: 'Promotional offer: get 10% cashback this weekend!',
  });
  assert.equal(unknownRes.parseStatus, 'UNPARSED');
  assert.equal(unknownRes.provider, 'UNKNOWN');
});
