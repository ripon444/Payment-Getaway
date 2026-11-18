import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMfsNotification, registerDynamicBankTemplates } from '../index.ts';

test('bKash Merchant Payment parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.bkash.merchant',
    body: 'You have received payment Tk 2,450.00 from 01755112233. Fee Tk 0.00. Balance Tk 42,150.00. TrxID BKH9X4M21Q.',
  });
  assert.equal(res.provider, 'BKASH');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.accountMode, 'MERCHANT');
  assert.equal(res.amountBdt, 2450);
  assert.equal(res.trxId, 'BKH9X4M21Q');
  assert.equal(res.senderPhone, '01755112233');
});

test('Nagad Personal Money Received parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.konasl.nagad',
    body: 'Money Received. Amount: Tk 4800.00 Sender: 01812334455 Ref: DC98409. TxnID: 71NGD8842K. Balance: Tk 29,400.00',
  });
  assert.equal(res.provider, 'NAGAD');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.accountMode, 'PERSONAL');
  assert.equal(res.amountBdt, 4800);
  assert.equal(res.trxId, '71NGD8842K');
});

test('DBBL Rocket Cash-In SMS parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.google.android.apps.messaging',
    senderHeader: '16216',
    body: 'Tk1,500.00 received from A/C 01688990011 Fee: Tk0.00 TxnId: RKT99201122. Balance: Tk18,900.00',
  });
  assert.equal(res.provider, 'ROCKET');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.amountBdt, 1500);
  assert.equal(res.trxId, 'RKT99201122');
});

test('UCB Upay Personal & Merchant parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.ucb.upay',
    body: 'You have received Tk 1,200.00 from 01722003344. TrxID UPAY771299. Balance Tk 8,450.00.',
  });
  assert.equal(res.provider, 'UPAY');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.amountBdt, 1200);
  assert.equal(res.trxId, 'UPAY771299');
  assert.equal(res.senderPhone, '01722003344');
});

test('Islami Bank CellFin notification parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.ibbl.cellfin',
    senderHeader: 'IBBL',
    body: 'IBBL CellFin: Your A/C 2050***318 credited BDT 1,950.00 via CellFin QR. TrxID: CFN4488210. Bal BDT 51,400.00',
  });
  assert.equal(res.provider, 'CELLFIN');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.amountBdt, 1950);
  assert.equal(res.trxId, 'CFN4488210');
  assert.equal(res.receiverAccount, '2050***318');
});

test('Bangla QR City Bank SMS parsing', () => {
  const res = parseMfsNotification({
    packageName: 'com.google.android.apps.messaging',
    senderHeader: 'CITYBANK',
    body: 'City Bank: Your A/C ***8841 credited by BDT 3,500.00 via BanglaQR from 01711223344. Ref: CBQR901288. Bal: BDT 145,200.00',
  });
  assert.equal(res.provider, 'BANGLA_QR');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.amountBdt, 3500);
  assert.equal(res.trxId, 'CBQR901288');
  assert.equal(res.bankName, 'The City Bank PLC');
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
    packageName: 'com.google.android.apps.messaging',
    senderHeader: 'PUBALIBANK',
    body: 'Pubali Bank: A/C ***9911 credited with BDT 7,250.00. Ref: PBL881209.',
  });
  assert.equal(res.provider, 'BANK_SMS');
  assert.equal(res.parseStatus, 'PARSED');
  assert.equal(res.bankName, 'Pubali Bank PLC');
  assert.equal(res.amountBdt, 7250);
  assert.equal(res.trxId, 'PBL881209');
});

test('Security filter blocks OTP/PIN messages and avoids guessing unverified formats', () => {
  const otpRes = parseMfsNotification({
    packageName: 'com.bKash.customerapp',
    body: 'Your bKash One Time Password OTP is 849201. Never share your PIN.',
  });
  assert.equal(otpRes.parseStatus, 'IGNORED_SECURITY');
  assert.equal(otpRes.amountBdt, null);
  assert.equal(otpRes.trxId, null);

  const unknownRes = parseMfsNotification({
    packageName: 'com.unknown.bank',
    body: 'Promotional offer: get 10% cashback this weekend!',
  });
  assert.equal(unknownRes.parseStatus, 'UNPARSED');
  assert.equal(unknownRes.provider, 'UNKNOWN');
});
