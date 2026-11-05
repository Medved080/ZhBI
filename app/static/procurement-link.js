// Shared session; V2 and the API enforce the dedicated service permission.
document.getElementById("menu-procurement")?.addEventListener("click", () => {
  window.location.href = "/v2#/procurement";
});
