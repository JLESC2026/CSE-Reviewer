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

/* ── DATABASE CONFIG ── update these with your InfinityFree phpMyAdmin credentials */
define('DB_HOST', 'sql303.infinityfree.com');
define('DB_NAME', 'if0_41949137_db_reviewer');
define('DB_USER', 'if0_41949137'); 
define('DB_PASS', '18WSfYvjIRzQA5');

function getDB() {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS,
        [ PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
          PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC ]
    );
    return $pdo;
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
            respond(true, $stmt->fetchAll());
        }
        respond(false, null, 'Unknown action');
    }

    /* ── POST: save a score ── */
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $body = json_decode(file_get_contents('php://input'), true);
        if (!$body) respond(false, null, 'Invalid JSON body');

        $username  = trim($body['username']  ?? '');
        $score_pct = intval($body['score_pct'] ?? 0);
        $correct   = intval($body['correct']   ?? 0);
        $total     = intval($body['total']     ?? 0);
        $mode      = in_array($body['mode'] ?? '', ['practice','exam']) ? $body['mode'] : 'practice';

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
