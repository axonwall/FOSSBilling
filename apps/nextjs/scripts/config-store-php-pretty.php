<?php
/**
 * FOSSBilling Phase 5 R5a — test helper only (not product code).
 * Reads a JSON object from stdin, decodes it as a PHP array, and
 * prints Config::prettyPrintArrayToPHP() output verbatim, so the
 * TS writer's byte-equality can be proven against the real PHP
 * pretty-printer. Usage: php config-store-php-pretty.php < sample.json
 */
declare(strict_types=1);

require __DIR__ . '/../../../src/library/FOSSBilling/Config.php';

$json = stream_get_contents(STDIN);
$array = json_decode($json, true);
if (!is_array($array)) {
    fwrite(STDERR, "expected a JSON object on stdin\n");
    exit(2);
}

$method = new ReflectionMethod(FOSSBilling\Config::class, 'prettyPrintArrayToPHP');
$method->setAccessible(true);
echo $method->invoke(null, $array);
