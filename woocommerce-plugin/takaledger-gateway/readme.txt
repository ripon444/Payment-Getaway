=== TakaLedger MFS & Bangla QR Gateway for WooCommerce ===
Contributors: takaledger
Tags: woocommerce, bkash, nagad, rocket, upay, bangla-qr, cellfin, bangladesh
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 8.0
Stable tag: 2.0.0
License: Apache-2.0

== Description ==
Integrates WooCommerce stores with the TakaLedger Multi-Merchant Payment Verification Gateway supporting bKash, Nagad, DBBL Rocket, Upay, Islami Bank CellFin, and Bangla QR.

== Installation ==
1. Zip the `takaledger-gateway` folder and upload via WordPress Admin -> Plugins -> Add New -> Upload Plugin.
2. Activate the plugin and go to WooCommerce -> Settings -> Payments -> TakaLedger MFS & Bangla QR.
3. Enter your Gateway Base URL, Merchant API Key (`X-Merchant-Key`), and Webhook HMAC Secret.
4. Register `https://yourstore.com/wp-json/takaledger/v1/webhook` as your Merchant Webhook URL in the TakaLedger Dashboard.
5. WooCommerce orders are ONLY marked paid when TakaLedger delivers a signed `payment.verified_settled` webhook with `status = SUCCESS`.
