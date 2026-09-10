# Вендоренный сторонний код — three.js r160

Подтверждено пользователем 2026-09-10 (задача «Загрузка FBX
благоустройства», `Docs/fbx-ground-implementation-task.md` §4).

| Файл | Источник | Версия | Лицензия | SHA-256 |
| --- | --- | --- | --- | --- |
| `three.module.min.js` | three.js `examples/build` (уже было в проекте) | r160 | MIT (`LICENSE`) | — |
| `OrbitControls.js` | three.js `examples/jsm/controls` (уже было) | r160 | MIT (`LICENSE`) | — |
| `examples/jsm/loaders/FBXLoader.js` | https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/loaders/FBXLoader.js | r160 | MIT (`LICENSE`) | `e8c2a47dffc04ca5699839a6d80fa9140fd9c943f62cea8d074736d7de9c5d98` |
| `examples/jsm/curves/NURBSCurve.js` | https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/curves/NURBSCurve.js | r160 | MIT (`LICENSE`) | `34dee297704432358680934a8d5acae35f05c71aa59ce7a8e97decb0ac38e452` |
| `examples/jsm/curves/NURBSUtils.js` | https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/curves/NURBSUtils.js | r160 | MIT (`LICENSE`) | `86bcf4002721854739f6dc7fd185b5eb0540d6b8676feaae6979bb605baac85e` |
| `examples/jsm/libs/fflate.module.js` | https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/libs/fflate.module.js | 0.6.9 (бандл three.js r160) | MIT (`examples/jsm/libs/fflate.LICENSE`) | `5686c3d02432a47d8e31f16cabc2d725bbf4531a3abb37cc6fd00142256e3730` |

Файлы не изменялись, кроме относительных путей импорта (уже относительные
в оригинале — не тронуты). `three` остаётся bare specifier из общего
importmap `app/static/index.html`, `FBXLoader.js` и `NURBSCurve.js`
импортируют его так же, как остальные модули `examples/jsm`.
