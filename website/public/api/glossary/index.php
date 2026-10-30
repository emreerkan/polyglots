<?php
/**
 * The current wp.org glossary export for one locale, for the website's
 * glossary editor: /polyglots/api/glossary/?locale=tr
 *
 * The browser cannot read the export itself. translate.wordpress.org sends no
 * Access-Control-Allow-Origin header and serves it as a download, so the page
 * asks this script on its own origin instead. The directory index serves it,
 * which keeps .php out of the URL without a rewrite rule above /polyglots/.
 *
 * Only the locale varies, it must be one of the slugs wp.org lists, and it
 * only ever fills the slug of one fixed wp.org URL, so this cannot be pointed
 * at anything else. There is no Access-Control-Allow-Origin here either:
 * other sites' pages cannot read it.
 *
 * Every locale's copy is kept for an hour, so visitors cost wp.org at most
 * one request per locale per hour. When wp.org fails, an older copy is served
 * rather than nothing, since a glossary from yesterday is still the right
 * file to start from; the X-Glossary-Stale header says so.
 */

declare(strict_types=1);

const TTL = 3600;
const UPSTREAM = 'https://translate.wordpress.org/locale/%s/default/glossary/-export/';
const USER_AGENT = 'polyglots-website/1.0 (+https://ada.tools/polyglots/)';
const MAX_BYTES = 5 * 1024 * 1024;

function fail(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo $message;
    exit;
}

function send(string $csv, int $age, bool $stale): never
{
    header('Content-Type: text/csv; charset=utf-8');
    header('Cache-Control: public, max-age=' . max(0, TTL - $age));
    header('X-Content-Type-Options: nosniff');
    if ($stale) header('X-Glossary-Stale: 1');
    echo $csv;
    exit;
}

/** A GlotPress glossary export starts with this header row, whatever the locale. */
function looksLikeExport(string $body): bool
{
    return str_starts_with(ltrim($body, "\u{FEFF}"), 'en,');
}

/** The export's body, or null on any failure: a status, a timeout, a page that is not an export. */
function fetchExport(string $slug): ?string
{
    $ch = curl_init(sprintf(UPSTREAM, $slug));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => USER_AGENT,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        // Stops the transfer once it is past the limit rather than holding it all.
        CURLOPT_NOPROGRESS => false,
        CURLOPT_XFERINFOFUNCTION => static fn($c, int $total, int $now): int => $now > MAX_BYTES ? 1 : 0,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if (!is_string($body) || $status !== 200 || !looksLikeExport($body)) return null;
    return $body;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') fail(405, 'GET only.');

// Only the slugs wp.org lists, written beside this script at build time from
// the list the locale picker shows. A slug that is not there never reaches
// wp.org, so a made-up one costs nothing upstream and leaves no file here.
$slug = is_string($_GET['locale'] ?? null) ? $_GET['locale'] : '';
$known = @file(__DIR__ . '/slugs.txt', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
if ($known === false) fail(500, 'No locale list.');
if (!in_array($slug, $known, true)) fail(400, 'Not a wp.org locale slug.');

$dir = sys_get_temp_dir() . '/polyglots-glossary';
if (!is_dir($dir) && !@mkdir($dir, 0700) && !is_dir($dir)) fail(500, 'No cache directory.');
$file = "$dir/$slug.csv";

$fresh = static function () use ($file): ?int {
    $mtime = @filemtime($file);
    return $mtime !== false && time() - $mtime < TTL ? time() - $mtime : null;
};

$age = $fresh();
if ($age !== null) send((string) file_get_contents($file), $age, false);

// One fetch per locale at a time: the requests that arrive while it runs wait
// for its copy instead of all asking wp.org.
$lock = fopen("$file.lock", 'c');
if ($lock === false) fail(500, 'No cache lock.');
flock($lock, LOCK_EX);
$age = $fresh();
if ($age !== null) send((string) file_get_contents($file), $age, false);

$body = fetchExport($slug);
if ($body !== null) {
    $tmp = "$file." . getmypid();
    if (file_put_contents($tmp, $body) !== false) rename($tmp, $file);
    send($body, 0, false);
}

$old = @file_get_contents($file);
if (is_string($old) && looksLikeExport($old)) send($old, TTL, true);
fail(502, "wp.org did not return a glossary for \"$slug\".");
