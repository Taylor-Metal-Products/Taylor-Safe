(function seedPublicSafetyProgramLibrary() {
  "use strict";

  window.SafetyOpsProgramLibrary = {
    meta: {
      sourceName: "Company safety library",
      sourceFolderId: null,
      sourceUrl: null,
      sourceCapturedOn: null,
      privacy: "Company access required",
      ingestionMode: "Sign in with an approved account to view your company's programs, forms, and source files.",
      counts: {
        programs: 0,
        digitalForms: 0,
        folders: 0,
        looseResources: 0
      },
      extraction: {
        extracted: 0,
        imageOnly: 0,
        ocrRequired: 0
      },
      binaryIngestion: {
        filesVerified: 0,
        totalBytes: 0,
        capturedOn: null,
        storageTarget: "Private company files"
      }
    },
    programs: [],
    forms: [],
    folders: [],
    looseResources: [],
    extracts: {}
  };
})();
