<?php
/**
 * api.php — CSE Reviewer Score Logger
 * Upload this to the same htdocs folder as index.html
 *
 * GET  api.php?action=scores  → returns last 50 scores (sorted by score DESC)
 * POST api.php (JSON body)    → saves a new score
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

function loadEnvFile(): array {
    $path = __DIR__ . '/.env';
    if (!is_readable($path)) {
        return [];
    }
    $values = parse_ini_file($path, false, INI_SCANNER_RAW);
    return $values ?: [];
}

$env = loadEnvFile();

function env(string $name, $default = null) {
    global $env;
    if (isset($env[$name]) && $env[$name] !== '') {
        return $env[$name];
    }
    $value = getenv($name);
    if ($value !== false && $value !== '') {
        return $value;
    }
    return $default;
}

/* ── DATABASE CONFIG ── use .env or environment variables */
define('DB_HOST', env('DB_HOST', 'sql303.infinityfree.com'));
define('DB_NAME', env('DB_NAME', 'if0_41949137_db_reviewer'));
define('DB_USER', env('DB_USER', 'if0_41949137'));
define('DB_PASS', env('DB_PASS', ''));
define('API_SECRET', env('API_SECRET', 'replace-with-a-long-random-secret'));

function getDB() {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS,
        [ PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
          PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC ]
    );
    return $pdo;
}

function getCsrfToken() {
    return hash_hmac('sha256', date('Y-m-d-H'), API_SECRET);
}

function validateInput(array $body): array {
    $username = substr(trim($body['username'] ?? ''), 0, 30);
    $mode     = in_array($body['mode'] ?? '', ['practice','exam'], true) ? $body['mode'] : 'practice';

    return [
        'username'  => $username,
        'score_pct' => max(0, min(100, intval($body['score_pct'] ?? 0))),
        'correct'   => max(0, intval($body['correct'] ?? 0)),
        'total'     => max(1, intval($body['total'] ?? 0)),
        'mode'      => $mode,
        'token'     => trim($body['token'] ?? ''),
    ];
}

function respond($success, $data = null, $error = null) {
    echo json_encode(compact('success', 'data', 'error'));
    exit;
}

try {
    $db = getDB();

    /* ── GET: fetch leaderboard ── */
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $action = $_GET['action'] ?? '';
        if ($action === 'scores') {
            $stmt = $db->query(
                'SELECT username, score_pct, correct, total, mode, taken_at
                 FROM score_logs
                 ORDER BY score_pct DESC, taken_at DESC
                 LIMIT 50'
            );
            respond(true, [
                'scores'     => $stmt->fetchAll(),
                'csrf_token' => getCsrfToken()
            ]);
        }

        if ($action === 'token') {
            respond(true, ['csrf_token' => getCsrfToken()]);
        }

        respond(false, null, 'Unknown action');
    }

    /* ── POST: save a score ── */
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $body = json_decode(file_get_contents('php://input'), true);
        if (!$body) respond(false, null, 'Invalid JSON body');

        $input = validateInput($body);
        if ($input['token'] !== getCsrfToken()) {
            respond(false, null, 'Invalid or expired token');
        }

        $username  = $input['username'];
        $score_pct = $input['score_pct'];
        $correct   = $input['correct'];
        $total     = $input['total'];
        $mode      = $input['mode'];

        if (!$username || strlen($username) > 30) respond(false, null, 'Invalid username');
        if ($total <= 0) respond(false, null, 'Invalid total');

        $stmt = $db->prepare(
            'INSERT INTO score_logs (username, score_pct, correct, total, mode)
             VALUES (:username, :score_pct, :correct, :total, :mode)'
        );
        $stmt->execute(compact('username', 'score_pct', 'correct', 'total', 'mode'));
        respond(true);
    }

    respond(false, null, 'Method not allowed');

} catch (Exception $e) {
    respond(false, null, $e->getMessage());
}
