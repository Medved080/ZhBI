// Права: сравнить прямой HTTP-вызов POST /schedule-versions/deviation под user2 (роль user, доступ к объекту 1) и
// user4 (роль view) — сервер сам решает по assert_object_feature(..., "schedule", "read"); клиентский код прав не añade.
const base = process.argv[2] || "http://127.0.0.1:8250";
const PASSWORD = "Test-Pass-1234!";

async function loginAndCall(user, objectId) {
  const jar = [];
  const login = await fetch(`${base}/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain_login: user, password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie");
  const res = await fetch(`${base}/schedule-versions/deviation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie || "" },
    body: JSON.stringify({ object_id: objectId }),
  });
  return { loginStatus: login.status, status: res.status, body: await res.text() };
}

(async () => {
  for (const user of ["user2", "user4"]) {
    const r = await loginAndCall(user, 1);
    console.log(user, "→ логин:", r.loginStatus, "| POST /schedule-versions/deviation (object_id=1):", r.status, r.body.slice(0, 200));
  }
})();
