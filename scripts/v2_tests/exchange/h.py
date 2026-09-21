import requests, sys, json
import os
BASE="http://127.0.0.1:%s"%os.environ.get("V2_EX_PORT","8150")
PW="Test-Pass-1234!"
def login(u):
    s=requests.Session()
    r=s.post(BASE+"/login",json={"domain_login":u,"password":PW})
    return s,r
if __name__=="__main__":
    for u in ("admin","user2","user3","user4"):
        s,r=login(u); print(u,r.status_code,r.text[:200])
