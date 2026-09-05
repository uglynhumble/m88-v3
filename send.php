<?php
/**
 * М88 — обработчик заявок с сайта.
 * Принимает POST (multipart/form-data) от форм на / и /press-formy/,
 * отправляет письмо с вложениями и отвечает JSON. Правки — в config.php.
 *
 * Требования: PHP 7.4+ (работает и на 8.x). Внешних библиотек не нужно.
 */

declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
mb_internal_encoding('UTF-8');

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const M88_MAX_FIELD_LEN = 5000;

/** @var array $CFG */
$CFG = require __DIR__ . '/config.php';

// ─────────────────────────────────────────────────────────────── утилиты ────

function reply(bool $ok, string $message, array $extra = [], int $code = 200): void
{
    http_response_code($code);
    echo json_encode(array_merge(['ok' => $ok, 'message' => $message], $extra),
        JSON_UNESCAPED_UNICODE);
    exit;
}

function clean(string $v): string
{
    $v = str_replace(["\r\n", "\r"], "\n", $v);
    $v = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $v) ?? '';
    return trim(mb_substr($v, 0, M88_MAX_FIELD_LEN));
}

function field(string $name): string
{
    return isset($_POST[$name]) && is_string($_POST[$name]) ? clean($_POST[$name]) : '';
}

/** Защита от инъекции заголовков письма. */
function headerSafe(string $v): string
{
    return trim(str_replace(["\r", "\n", "\0"], ' ', $v));
}

function mimeHeader(string $v): string
{
    $v = headerSafe($v);
    return preg_match('/[^\x20-\x7E]/', $v)
        ? '=?UTF-8?B?' . base64_encode($v) . '?='
        : $v;
}

function clientIp(): string
{
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
        if (!empty($_SERVER[$k])) {
            $ip = trim(explode(',', (string) $_SERVER[$k])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip;
        }
    }
    return '0.0.0.0';
}

function ensureDir(string $dir): bool
{
    if (is_dir($dir)) return true;
    return @mkdir($dir, 0755, true) && is_dir($dir);
}

// ───────────────────────────────────────────────────────── предпроверки ────

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    reply(false, 'Метод не поддерживается.', [], 405);
}

// POST пришёл, но пустой — значит, файлы превысили post_max_size в php.ini
if (empty($_POST) && empty($_FILES) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    reply(false, 'Файлы слишком большие для сервера. Уменьшите вложения или пришлите ссылку на облако.', [], 413);
}

// Honeypot: скрытое поле, которое заполняют только боты
if (field('website') !== '' || field('fax') !== '') {
    reply(true, 'Заявка отправлена.');   // тихо «принимаем» и ничего не шлём
}

// Слишком быстрая отправка = бот
$startedAt = (int) field('form_started');
if ($startedAt > 0) {
    $elapsed = time() - (int) round($startedAt / 1000);
    if ($elapsed >= 0 && $elapsed < (int) $CFG['min_fill_seconds']) {
        // Живой человек (например, с автозаполнением) просто подождёт секунду —
        // скрипт формы повторит отправку сам. Боты сюда не возвращаются.
        reply(false, 'Секунду, отправляем…', [
            'retry_after' => (int) $CFG['min_fill_seconds'] - $elapsed + 1,
        ], 429);
    }
}

// Лимит частоты по IP. Считаем только доставленные заявки — чтобы человек,
// ошибившийся в поле, не оказался заблокирован.
$ip     = clientIp();
$rlFile = ensureDir($CFG['log_dir'])
    ? rtrim($CFG['log_dir'], '/') . '/rate_' . md5($ip) . '.json'
    : '';

$rateHits = [];
if ($rlFile !== '' && is_file($rlFile)) {
    $rateHits = json_decode((string) @file_get_contents($rlFile), true) ?: [];
}
$rateHits = array_values(array_filter(
    $rateHits,
    static fn($t) => time() - (int) $t < (int) $CFG['rate_limit_window']
));
if (count($rateHits) >= (int) $CFG['rate_limit_count']) {
    reply(false, 'Слишком много заявок с этого адреса. Напишите, пожалуйста, на zakaz@m88.su.', [], 429);
}

// ────────────────────────────────────────────────────────────── поля ────

$name    = field('name');
$company = field('company');
$role    = field('role');
$phone   = field('phone');
$email   = field('email');
$contact = field('contact');            // лендинг: единое поле «e-mail или телефон»
$message = field('message') ?: field('task');
$page    = field('page') ?: 'сайт М88';

if ($name === '') {
    reply(false, 'Укажите, пожалуйста, имя.', ['field' => 'name'], 422);
}
if ($phone === '' && $email === '' && $contact === '') {
    reply(false, 'Оставьте телефон или e-mail для связи.', ['field' => 'contact'], 422);
}
if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    reply(false, 'Проверьте адрес электронной почты.', ['field' => 'email'], 422);
}
if ($phone !== '') {
    $digits  = preg_replace('/\D/', '', $phone) ?? '';
    $foreign = $phone[0] === '+' && isset($phone[1]) && $phone[1] !== '7';
    if (strlen($digits) < ($foreign ? 8 : 11)) {
        reply(false, 'Проверьте номер телефона — не хватает цифр.', ['field' => 'phone'], 422);
    }
    // приводим российские номера к единому виду: +7 (999) 123-45-67
    if (!$foreign && strlen($digits) === 11) {
        $phone = sprintf('+7 (%s) %s-%s-%s',
            substr($digits, 1, 3), substr($digits, 4, 3), substr($digits, 7, 2), substr($digits, 9, 2));
    }
}

// Определяем адрес для Reply-To
$replyTo = '';
if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $replyTo = $email;
} elseif ($contact !== '' && filter_var($contact, FILTER_VALIDATE_EMAIL)) {
    $replyTo = $contact;
}

// ─────────────────────────────────────────────────────────── вложения ────

$attachments = [];
$totalBytes  = 0;
$skipped     = [];

$phpUploadErrors = [
    UPLOAD_ERR_INI_SIZE   => 'превышает лимит сервера',
    UPLOAD_ERR_FORM_SIZE  => 'превышает лимит формы',
    UPLOAD_ERR_PARTIAL    => 'загрузился не полностью',
    UPLOAD_ERR_NO_TMP_DIR => 'нет временной папки на сервере',
    UPLOAD_ERR_CANT_WRITE => 'не удалось записать на диск',
    UPLOAD_ERR_EXTENSION  => 'заблокирован расширением PHP',
];

foreach ($_FILES as $group) {
    // Нормализуем и одиночные поля, и массивы file[]
    $items = is_array($group['name'])
        ? array_map(static fn($i) => [
            'name'     => $group['name'][$i],
            'tmp_name' => $group['tmp_name'][$i],
            'size'     => $group['size'][$i],
            'error'    => $group['error'][$i],
        ], array_keys($group['name']))
        : [$group];

    foreach ($items as $f) {
        if ((int) $f['error'] === UPLOAD_ERR_NO_FILE) continue;

        $orig = clean((string) $f['name']);
        $base = mb_substr(preg_replace('/[\/\\\\\x00]/', '_', $orig) ?? 'file', 0, 120);

        if ((int) $f['error'] !== UPLOAD_ERR_OK) {
            $skipped[] = $base . ' — ' . ($phpUploadErrors[(int) $f['error']] ?? 'ошибка загрузки');
            continue;
        }
        if (!is_uploaded_file((string) $f['tmp_name'])) {
            $skipped[] = $base . ' — файл не принят';
            continue;
        }
        if (count($attachments) >= (int) $CFG['max_files']) {
            $skipped[] = $base . ' — превышен лимит в ' . $CFG['max_files'] . ' файлов';
            continue;
        }

        $ext = strtolower((string) pathinfo($base, PATHINFO_EXTENSION));
        if (!in_array($ext, $CFG['allowed_ext'], true)) {
            $skipped[] = $base . ' — формат не поддерживается';
            continue;
        }

        $size = (int) $f['size'];
        if ($totalBytes + $size > (int) $CFG['max_total_bytes']) {
            $skipped[] = $base . ' — превышен общий лимит ' . round($CFG['max_total_bytes'] / 1048576) . ' МБ';
            continue;
        }

        $data = @file_get_contents((string) $f['tmp_name']);
        if ($data === false) {
            $skipped[] = $base . ' — не удалось прочитать';
            continue;
        }

        $attachments[] = ['name' => $base, 'data' => $data, 'size' => $size];
        $totalBytes   += $size;
    }
}

// ──────────────────────────────────────────────────────────── письмо ────

$ticket = strtoupper(substr(md5($ip . microtime(true)), 0, 6));
$when   = (new DateTimeImmutable('now', new DateTimeZone('Europe/Moscow')))->format('d.m.Y H:i');

$rows = array_filter([
    'Имя'        => $name,
    'Компания'   => $company,
    'Должность'  => $role,
    'Телефон'    => $phone,
    'E-mail'     => $email,
    'Контакт'    => $contact,
], static fn($v) => $v !== '');

$plain  = "Новая заявка с сайта М88\n";
$plain .= "Номер: {$ticket}   ·   {$when} (МСК)\n";
$plain .= "Страница: {$page}\n";
$plain .= str_repeat('-', 46) . "\n";
foreach ($rows as $k => $v) {
    $plain .= "{$k}: {$v}\n";
}
if ($message !== '') {
    $plain .= "\nЗадача:\n{$message}\n";
}
if ($attachments) {
    $plain .= "\nВложения (" . count($attachments) . "):\n";
    foreach ($attachments as $a) {
        $plain .= '  • ' . $a['name'] . ' (' . round($a['size'] / 1024) . " КБ)\n";
    }
}
if ($skipped) {
    $plain .= "\nНе приложены:\n";
    foreach ($skipped as $s) $plain .= "  • {$s}\n";
}
$plain .= "\n" . str_repeat('-', 46) . "\nIP: {$ip}\n";

$e = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');

$html  = '<!doctype html><html lang="ru"><meta charset="utf-8"><body style="margin:0;background:#f3f5f7;padding:24px;font:15px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#14181d">';
$html .= '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:10px;overflow:hidden"><tr><td style="background:#14171c;padding:18px 24px;color:#fff">';
$html .= '<div style="font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.16em;color:#FF9E2C;text-transform:uppercase">Заявка с сайта · ' . $e($ticket) . '</div>';
$html .= '<div style="font-size:19px;font-weight:700;margin-top:6px">' . $e($name !== '' ? $name : 'Без имени') . ($company !== '' ? ' <span style="opacity:.6;font-weight:400">— ' . $e($company) . '</span>' : '') . '</div>';
$html .= '</td></tr><tr><td style="padding:20px 24px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:15px">';
foreach ($rows as $k => $v) {
    $val = $e($v);
    if ($k === 'E-mail' || ($k === 'Контакт' && filter_var($v, FILTER_VALIDATE_EMAIL))) {
        $val = '<a href="mailto:' . $e($v) . '" style="color:#D2530C">' . $val . '</a>';
    } elseif ($k === 'Телефон') {
        $val = '<a href="tel:' . $e(preg_replace('/[^\d+]/', '', $v) ?? '') . '" style="color:#D2530C">' . $val . '</a>';
    }
    $html .= '<tr><td style="padding:6px 14px 6px 0;color:#5A616B;white-space:nowrap;vertical-align:top">' . $e($k) . '</td><td style="padding:6px 0;font-weight:600">' . $val . '</td></tr>';
}
$html .= '</table>';
if ($message !== '') {
    $html .= '<div style="margin-top:16px;padding:14px 16px;background:#f6f7f9;border-left:3px solid #F26A1B;border-radius:0 6px 6px 0"><div style="font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;color:#5A616B;text-transform:uppercase;margin-bottom:8px">Задача</div><div style="white-space:pre-wrap">' . nl2br($e($message)) . '</div></div>';
}
if ($attachments) {
    $html .= '<div style="margin-top:16px;font-size:14px"><b>Вложения:</b><br>';
    foreach ($attachments as $a) {
        $html .= '&bull; ' . $e($a['name']) . ' <span style="color:#5A616B">(' . round($a['size'] / 1024) . ' КБ)</span><br>';
    }
    $html .= '</div>';
}
if ($skipped) {
    $html .= '<div style="margin-top:14px;font-size:13px;color:#b0430c"><b>Не приложены:</b><br>' . $e(implode(' · ', $skipped)) . '</div>';
}
$html .= '<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e8ebee;font-size:12px;color:#8b929c">' . $e($page) . ' · ' . $e($when) . ' МСК · IP ' . $e($ip) . '</div>';
$html .= '</td></tr></table></body></html>';

$subjectWho = $company !== '' ? $company : $name;
$subject    = 'Заявка с сайта М88 — ' . $subjectWho . ' [' . $ticket . ']';

// ────────────────────────────────────────────────── сборка MIME и отправка ────

function buildMime(string $plain, string $html, array $attachments, array &$headers): string
{
    $altB = '=_alt_' . bin2hex(random_bytes(8));
    $mixB = '=_mix_' . bin2hex(random_bytes(8));

    $alt  = "--{$altB}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
          . chunk_split(base64_encode($plain)) . "\r\n"
          . "--{$altB}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
          . chunk_split(base64_encode($html)) . "\r\n"
          . "--{$altB}--\r\n";

    if (!$attachments) {
        $headers['Content-Type'] = "multipart/alternative; boundary=\"{$altB}\"";
        return $alt;
    }

    $body  = "--{$mixB}\r\nContent-Type: multipart/alternative; boundary=\"{$altB}\"\r\n\r\n" . $alt . "\r\n";
    foreach ($attachments as $a) {
        $fname = mimeHeader($a['name']);
        $body .= "--{$mixB}\r\n"
               . "Content-Type: application/octet-stream; name=\"{$fname}\"\r\n"
               . "Content-Transfer-Encoding: base64\r\n"
               . "Content-Disposition: attachment; filename=\"{$fname}\"\r\n\r\n"
               . chunk_split(base64_encode($a['data'])) . "\r\n";
    }
    $body .= "--{$mixB}--\r\n";

    $headers['Content-Type'] = "multipart/mixed; boundary=\"{$mixB}\"";
    return $body;
}

/** Минимальный SMTP-клиент (используется, если smtp_enabled = true). */
function smtpSend(array $cfg, array $to, string $rawHeaders, string $body, string &$err): bool
{
    $host = ($cfg['smtp_secure'] === 'ssl' ? 'ssl://' : '') . $cfg['smtp_host'];
    $fp   = @stream_socket_client($host . ':' . (int) $cfg['smtp_port'], $errno, $errstr, 20);
    if (!$fp) { $err = "SMTP connect: {$errstr}"; return false; }
    stream_set_timeout($fp, 20);

    $read = static function () use ($fp): string {
        $out = '';
        while (($line = fgets($fp, 1024)) !== false) {
            $out .= $line;
            if (strlen($line) < 4 || $line[3] !== '-') break;
        }
        return $out;
    };
    $cmd = static function (string $c, string $expect) use ($fp, $read, &$err): bool {
        if ($c !== '') fwrite($fp, $c . "\r\n");
        $r = $read();
        if (strncmp($r, $expect, strlen($expect)) !== 0) { $err = 'SMTP: ' . trim($r); return false; }
        return true;
    };

    if (!$cmd('', '220')) { fclose($fp); return false; }
    if (!$cmd('EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'), '250')) { fclose($fp); return false; }

    if ($cfg['smtp_secure'] === 'tls') {
        if (!$cmd('STARTTLS', '220')) { fclose($fp); return false; }
        if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            $err = 'SMTP: STARTTLS failed'; fclose($fp); return false;
        }
        if (!$cmd('EHLO ' . ($_SERVER['SERVER_NAME'] ?? 'localhost'), '250')) { fclose($fp); return false; }
    }

    if (!$cmd('AUTH LOGIN', '334')) { fclose($fp); return false; }
    if (!$cmd(base64_encode((string) $cfg['smtp_user']), '334')) { fclose($fp); return false; }
    if (!$cmd(base64_encode((string) $cfg['smtp_pass']), '235')) { fclose($fp); return false; }
    if (!$cmd('MAIL FROM:<' . $cfg['from'] . '>', '250')) { fclose($fp); return false; }
    foreach ($to as $rcpt) {
        if (!$cmd('RCPT TO:<' . $rcpt . '>', '250')) { fclose($fp); return false; }
    }
    if (!$cmd('DATA', '354')) { fclose($fp); return false; }

    // Точка в начале строки экранируется по RFC 5321
    $data = preg_replace('/^\./m', '..', $rawHeaders . "\r\n" . $body);
    fwrite($fp, $data . "\r\n.\r\n");
    if (!$cmd('', '250')) { fclose($fp); return false; }
    $cmd('QUIT', '221');
    fclose($fp);
    return true;
}

$recipients = array_values(array_filter(array_map('trim', explode(',', (string) $CFG['to']))));
if (!$recipients) {
    reply(false, 'Адрес получателя не настроен. Напишите на zakaz@m88.su.', [], 500);
}

$headers = [
    'MIME-Version' => '1.0',
    'From'         => mimeHeader((string) $CFG['from_name']) . ' <' . headerSafe((string) $CFG['from']) . '>',
    'Date'         => date('r'),
    'Message-ID'   => '<' . $ticket . '.' . time() . '@' . (($_SERVER['SERVER_NAME'] ?? 'm88.su')) . '>',
    'X-Mailer'     => 'M88-site',
];
if ($replyTo !== '') {
    $headers['Reply-To'] = mimeHeader($name) . ' <' . headerSafe($replyTo) . '>';
}
if (!empty($CFG['bcc'])) {
    $headers['Bcc'] = headerSafe((string) $CFG['bcc']);
}

$body = buildMime($plain, $html, $attachments, $headers);

$sent    = false;
$sendErr = '';

if (!empty($CFG['smtp_enabled'])) {
    $smtpHeaders = "To: " . implode(', ', $recipients) . "\r\n"
                 . "Subject: " . mimeHeader($subject) . "\r\n";
    foreach ($headers as $k => $v) {
        if ($k === 'Bcc') continue;               // Bcc не пишем в заголовки
        $smtpHeaders .= "{$k}: {$v}\r\n";
    }
    $rcpts = $recipients;
    if (!empty($CFG['bcc'])) $rcpts[] = trim((string) $CFG['bcc']);
    $sent = smtpSend($CFG, $rcpts, rtrim($smtpHeaders, "\r\n"), $body, $sendErr);
} else {
    $hdrString = '';
    foreach ($headers as $k => $v) {
        $hdrString .= "{$k}: {$v}\r\n";
    }
    $sent = @mail(
        implode(', ', $recipients),
        mimeHeader($subject),
        $body,
        rtrim($hdrString, "\r\n"),
        '-f' . escapeshellcmd((string) $CFG['from'])
    );
    if (!$sent) $sendErr = 'mail() вернул false';
}

// ───────────────────────────────────────────────────── журнал и Telegram ────

if ($sent && $rlFile !== '') {
    $rateHits[] = time();
    @file_put_contents($rlFile, json_encode($rateHits), LOCK_EX);
}

if (!empty($CFG['log_enabled']) && ensureDir($CFG['log_dir'])) {
    $dir = rtrim($CFG['log_dir'], '/');

    // .htaccess + index.html, чтобы папка не читалась из браузера
    if (!is_file($dir . '/.htaccess')) {
        @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
    }
    if (!is_file($dir . '/index.html')) {
        @file_put_contents($dir . '/index.html', '');
    }

    $csv = $dir . '/leads.csv';
    $new = !is_file($csv);
    if ($fh = @fopen($csv, 'a')) {
        if (flock($fh, LOCK_EX)) {
            if ($new) {
                fwrite($fh, "\xEF\xBB\xBF");    // BOM — чтобы Excel открыл кириллицу
                fputcsv($fh, ['Дата', 'Номер', 'Страница', 'Имя', 'Компания', 'Должность',
                              'Телефон', 'E-mail', 'Контакт', 'Задача', 'Файлы', 'Отправлено', 'IP'], ';');
            }
            fputcsv($fh, [
                $when, $ticket, $page, $name, $company, $role, $phone, $email, $contact,
                $message, implode(' | ', array_column($attachments, 'name')),
                $sent ? 'да' : 'нет (' . $sendErr . ')', $ip,
            ], ';');
            flock($fh, LOCK_UN);
        }
        fclose($fh);
    }

    if (!empty($CFG['keep_uploads']) && $attachments && ensureDir($dir . '/files')) {
        foreach ($attachments as $i => $a) {
            @file_put_contents($dir . '/files/' . $ticket . '-' . ($i + 1) . '-' . $a['name'], $a['data']);
        }
    }
}

if (!empty($CFG['telegram_token']) && !empty($CFG['telegram_chat_id']) && function_exists('curl_init')) {
    $tg  = "<b>Заявка с сайта М88</b> · {$ticket}\n";
    foreach ($rows as $k => $v) $tg .= "{$k}: " . htmlspecialchars($v, ENT_NOQUOTES, 'UTF-8') . "\n";
    if ($message !== '') $tg .= "\n" . htmlspecialchars(mb_substr($message, 0, 1500), ENT_NOQUOTES, 'UTF-8');
    if ($attachments)    $tg .= "\n\nФайлы: " . htmlspecialchars(implode(', ', array_column($attachments, 'name')), ENT_NOQUOTES, 'UTF-8');
    $ch = curl_init('https://api.telegram.org/bot' . $CFG['telegram_token'] . '/sendMessage');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_POSTFIELDS     => http_build_query([
            'chat_id'    => $CFG['telegram_chat_id'],
            'text'       => $tg,
            'parse_mode' => 'HTML',
        ]),
    ]);
    @curl_exec($ch);
    curl_close($ch);
}

// ──────────────────────────────────────────────────────────────── ответ ────

if (!$sent) {
    error_log('[M88] Не удалось отправить заявку ' . $ticket . ': ' . $sendErr);
    reply(false,
        'Не удалось отправить письмо. Позвоните нам: +7 (499) 325-69-82 или напишите на zakaz@m88.su.',
        ['ticket' => $ticket], 500);
}

reply(true, 'Заявка отправлена.', [
    'ticket'  => $ticket,
    'skipped' => $skipped,
]);
