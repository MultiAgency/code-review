# Redacts recordings from record.mts into test/fixtures/sdk/: ids, temp paths, home, signatures, tokens.
#   python3 redact.py <recordings dir> test/fixtures/sdk
import json, os, re, sys
src, dst = sys.argv[1].rstrip('/') + '/', sys.argv[2].rstrip('/') + '/'
home = os.path.expanduser('~')
ID_KEYS = {'session_id', 'uuid', 'request_id', 'id', 'parent_uuid', 'user_message_uuid', 'tool_use_id'}
def red(v, key=None):
    if isinstance(v, dict): return {k: red(x, k) for k, x in v.items()}
    if isinstance(v, list): return [red(x, key) for x in v]
    if isinstance(v, str):
        if key in ID_KEYS and v: return '<id>'
        if key in ('signature', 'messaging_socket_path'): return '<redacted>'
        v = re.sub(r'/tmp/record-[A-Za-z0-9]+', '<ROOT>', v)
        v = v.replace(home, '<HOME>')
        return re.sub(r'sk-ant-[A-Za-z0-9_-]+', '<token>', v)
    return v
for f in sorted(os.listdir(src)):
    lines = [red(json.loads(l)) for l in open(src + f) if l.strip()]
    text = '\n'.join(json.dumps(l) for l in lines) + '\n'
    assert home not in text and 'sk-ant' not in text and '/tmp/record-' not in text, f
    open(dst + f, 'w').write(text)
