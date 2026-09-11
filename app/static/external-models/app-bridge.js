// Единая точка загрузки THREE + FBXLoader + модулей внешних 3D-моделей —
// общая для просмотрщиков (МФР/ЖБИ, app.js) и панели настроек проекта
// (settings.js), чтобы загрузчик и математика не размножались по местам
// использования (стоячая инструкция задания). Модуль сам ничего не рисует
// и не хранит состояние сцены — только один раз подгружает зависимости.
let cached = null;

export async function ensureExternalModelsLoaded() {
  if (cached) return cached;
  const [THREE, { FBXLoader }, fbxModule, layerModule, coordsModule, calibrateModule, autoAlignModule] = await Promise.all([
    import("three"),
    import("/static/vendor/three/examples/jsm/loaders/FBXLoader.js"),
    import("/static/external-models/fbx.js"),
    import("/static/external-models/layer.js"),
    import("/static/external-models/coordinates.js"),
    import("/static/external-models/calibrate.js"),
    import("/static/external-models/auto-align.js"),
  ]);
  cached = {
    THREE,
    FBXLoader,
    loadExternalModelFbx: fbxModule.loadExternalModelFbx,
    disposeThreeGroup: fbxModule.disposeThreeGroup,
    createExternalModelLayer: layerModule.createExternalModelLayer,
    ...coordsModule,
    beginPointPairCalibration: calibrateModule.beginPointPairCalibration,
    computeTransferToModel: calibrateModule.computeTransferToModel,
    autoAlignFacade: autoAlignModule.autoAlignFacade,
    candidateToPlacement: autoAlignModule.candidateToPlacement,
    extractWallSegmentsFromGroup: autoAlignModule.extractWallSegmentsFromGroup,
  };
  return cached;
}
