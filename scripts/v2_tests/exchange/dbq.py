import sys, json, sqlite3, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import dbsnap
cmd = sys.argv[1]
if cmd == "snap": print(json.dumps(dbsnap.snap(), ensure_ascii=False))
elif cmd == "maxid": print(dbsnap.maxid())
elif cmd == "journal": print(json.dumps(dbsnap.journal(sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None, int(sys.argv[3]) if len(sys.argv) > 3 else None), ensure_ascii=False))
elif cmd == "sql":
    c = sqlite3.connect("file:" + dbsnap.DB + "?mode=ro", uri=True); c.row_factory = sqlite3.Row
    print(json.dumps([dict(r) for r in c.execute(sys.argv[2])], ensure_ascii=False, default=str))
