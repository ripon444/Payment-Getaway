<?php
/**
 * Plugin Name: TakaLedger MFS & Bangla QR Payment Gateway
 * Plugin URI:  https://takaledger.bd
 * Description: Accept bKash, Nagad, Rocket, Upay, CellFin, Bangla QR, and Bank transfer payments via TakaLedger verification gateway.
 * Version:     2.0.0
 * Author:      TakaLedger
 * License:     Apache-2.0
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('plugins_loaded', 'takaledger_wc_gateway_init', 11);

function takaledger_wc_gateway_init() {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }

    class WC_Gateway_TakaLedger extends WC_Payment_Gateway {
        public string $gateway_url;
        public string $api_key;
        public string $webhook_secret;
        public string $default_provider;

        public function __construct() {
            $this->id                 = 'takaledger';
            $this->method_title       = __('TakaLedger MFS & Bangla QR', 'takaledger');
            $this->method_description = __('Automated candidate matching & verified settlement for bKash, Nagad, Rocket, Upay, CellFin & Bangla QR.', 'takaledger');
            $this->has_fields         = true;
            $this->supports           = array('products');

            $this->init_form_fields();
            $this->init_settings();

            $this->title            = $this->get_option('title', 'bKash / Nagad / Rocket / Bangla QR');
            $this->description      = $this->get_option('description', 'Pay securely using bKash, Nagad, Rocket, Upay, CellFin, or Bangla QR.');
            $this->gateway_url      = untrailingslashit($this->get_option('gateway_url', ''));
            $this->api_key          = $this->get_option('api_key', '');
            $this->webhook_secret   = $this->get_option('webhook_secret', '');
            $this->default_provider = $this->get_option('default_provider', 'BKASH');

            add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
        }

        public function init_form_fields() {
            $this->form_fields = array(
                'enabled' => array(
                    'title'   => __('Enable/Disable', 'takaledger'),
                    'type'    => 'checkbox',
                    'label'   => __('Enable TakaLedger MFS Gateway', 'takaledger'),
                    'default' => 'yes',
                ),
                'title' => array(
                    'title'   => __('Title', 'takaledger'),
                    'type'    => 'text',
                    'default' => __('Mobile Banking & Bangla QR (bKash / Nagad / Rocket / Upay / CellFin)', 'takaledger'),
                ),
                'gateway_url' => array(
                    'title'       => __('Gateway Base URL', 'takaledger'),
                    'type'        => 'url',
                    'description' => __('e.g. https://pay.yourdomain.com', 'takaledger'),
                ),
                'api_key' => array(
                    'title' => __('Merchant API Key (X-Merchant-Key)', 'takaledger'),
                    'type'  => 'password',
                ),
                'webhook_secret' => array(
                    'title'       => __('Webhook HMAC Secret', 'takaledger'),
                    'type'        => 'password',
                    'description' => __('Webhook URL: /wp-json/takaledger/v1/webhook', 'takaledger'),
                ),
                'default_provider' => array(
                    'title'   => __('Default MFS Method', 'takaledger'),
                    'type'    => 'select',
                    'default' => 'BKASH',
                    'options' => array(
                        'BKASH'     => 'bKash',
                        'NAGAD'     => 'Nagad',
                        'ROCKET'    => 'DBBL Rocket',
                        'UPAY'      => 'Upay',
                        'CELLFIN'   => 'Islami Bank CellFin',
                        'BANGLA_QR' => 'Bangla QR',
                    ),
                ),
            );
        }

        public function payment_fields() {
            echo '<p>' . esc_html($this->description) . '</p>';
            echo '<label for="takaledger_provider">' . esc_html__('Select Payment Method', 'takaledger') . '</label>';
            echo '<select id="takaledger_provider" name="takaledger_provider" style="width:100%;padding:8px;margin-top:6px;">';
            $methods = array(
                'BKASH'     => 'bKash',
                'NAGAD'     => 'Nagad',
                'ROCKET'    => 'DBBL Rocket',
                'UPAY'      => 'Upay',
                'CELLFIN'   => 'Islami Bank CellFin',
                'BANGLA_QR' => 'Bangla QR (Any Bank / MFS App)',
            );
            foreach ($methods as $code => $label) {
                $sel = selected($this->default_provider, $code, false);
                echo '<option value="' . esc_attr($code) . '" ' . $sel . '>' . esc_html($label) . '</option>';
            }
            echo '</select>';
        }

        public function process_payment($order_id) {
            $order = wc_get_order($order_id);
            $provider = isset($_POST['takaledger_provider'])
                ? sanitize_text_field(wp_unslash($_POST['takaledger_provider']))
                : $this->default_provider;

            $payload = array(
                'merchantOrderId' => 'WC-' . $order->get_id(),
                'provider'        => $provider,
                'amountBdt'       => floatval($order->get_total()),
                'customerName'    => trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()),
                'customerPhone'   => $order->get_billing_phone(),
                'customerEmail'   => $order->get_billing_email(),
                'metadata'        => array('wc_order_id' => $order->get_id()),
            );

            $response = wp_remote_post($this->gateway_url . '/api/v1/payments', array(
                'timeout' => 15,
                'headers' => array(
                    'Content-Type'    => 'application/json',
                    'X-Merchant-Key'  => $this->api_key,
                    'Idempotency-Key' => 'wc-order-' . $order->get_id() . '-' . $order->get_order_key(),
                ),
                'body' => wp_json_encode($payload),
            ));

            if (is_wp_error($response)) {
                wc_add_notice(__('Payment gateway connection failed.', 'takaledger'), 'error');
                return array('result' => 'fail');
            }

            $body = json_decode(wp_remote_retrieve_body($response), true);
            if (empty($body['checkoutUrl'])) {
                wc_add_notice(__('Unable to initialize payment session.', 'takaledger'), 'error');
                return array('result' => 'fail');
            }

            $order->update_meta_data('_takaledger_payment_id', sanitize_text_field($body['paymentId']));
            $order->update_status('on-hold', __('Awaiting TakaLedger verified MFS settlement.', 'takaledger'));
            $order->save();

            return array(
                'result'   => 'success',
                'redirect' => esc_url_raw($body['checkoutUrl']),
            );
        }
    }

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_TakaLedger';
        return $gateways;
    });
}

// Signed Webhook Endpoint: /wp-json/takaledger/v1/webhook
add_action('rest_api_init', function () {
    register_rest_route('takaledger/v1', '/webhook', array(
        'methods'             => 'POST',
        'callback'            => 'takaledger_handle_wc_webhook',
        'permission_callback' => '__return_true',
    ));
});

function takaledger_handle_wc_webhook(WP_REST_Request $request) {
    $settings = get_option('woocommerce_takaledger_settings', array());
    $secret   = $settings['webhook_secret'] ?? '';
    $raw_body = $request->get_body();
    $sig_hdr  = $request->get_header('x-gateway-signature');

    if (empty($secret) || empty($sig_hdr)) {
        return new WP_REST_Response(array('error' => 'Missing webhook signature or secret'), 401);
    }

    // Parse t=<unix>,v1=<hex>
    $parts = array();
    foreach (explode(',', $sig_hdr) as $kv) {
        $pair = explode('=', trim($kv), 2);
        if (count($pair) === 2) {
            $parts[$pair[0]] = $pair[1];
        }
    }

    if (empty($parts['t']) || empty($parts['v1'])) {
        return new WP_REST_Response(array('error' => 'Malformed signature header'), 401);
    }

    if (abs(time() - intval($parts['t'])) > 300) {
        return new WP_REST_Response(array('error' => 'Webhook timestamp outside replay window'), 401);
    }

    $expected = hash_hmac('sha256', $parts['t'] . '.' . $raw_body, $secret);
    if (!hash_equals($expected, strtolower($parts['v1']))) {
        return new WP_REST_Response(array('error' => 'Invalid HMAC signature'), 401);
    }

    $payload = json_decode($raw_body, true);
    $event   = $payload['event'] ?? '';
    $data    = $payload['data'] ?? array();
    $order_ref = $data['merchantOrderId'] ?? '';

    if (strpos($order_ref, 'WC-') === 0) {
        $wc_order_id = intval(substr($order_ref, 3));
        $order = wc_get_order($wc_order_id);
        if ($order) {
            if ($event === 'payment.verified_settled' && ($data['status'] ?? '') === 'SUCCESS') {
                // Only confirm WooCommerce order after authoritative verification!
                if (!$order->is_paid()) {
                    $order->payment_complete($data['trxId'] ?? '');
                    $order->add_order_note(sprintf(
                        __('TakaLedger Verified Settlement (%s): TrxID %s | Ref %s', 'takaledger'),
                        $data['verificationSource'] ?? 'VERIFIED',
                        $data['trxId'] ?? '',
                        $data['documentaryEvidenceRef'] ?? ''
                    ));
                }
            } elseif ($event === 'payment.matched') {
                $order->add_order_note(__('TakaLedger: Notification candidate matched. Waiting for authoritative verification before completing order.', 'takaledger'));
            } elseif ($event === 'payment.failed') {
                $order->update_status('failed', __('TakaLedger: Payment verification failed or rejected.', 'takaledger'));
            }
        }
    }

    return new WP_REST_Response(array('received' => true), 200);
}
