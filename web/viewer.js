'use strict';

function getViewerConfiguration() {
  return {
    appContainer: document.body,
    mainContainer: document.getElementById('viewerContainer'),
    viewerContainer: document.getElementById('viewer'),
    eventBus: null, // Using global event bus with (optional) DOM events.
  };
}

function webViewerLoad() {
  let config = getViewerConfiguration();
  Promise.all([
    SystemJS.import('pdfjs-web/app'),
    SystemJS.import('pdfjs-web/app_options'),
  ]).then(function ([app, appOptions]) {
    window.PDFViewerApplication = app.PDFViewerApplication;
    window.PDFViewerApplicationOptions = appOptions.AppOptions;
    app.PDFViewerApplication.run(config);
  });
}

if (document.readyState === 'interactive' ||
    document.readyState === 'complete') {
  webViewerLoad();
} else {
  document.addEventListener('DOMContentLoaded', webViewerLoad, true);
  setTimeout(() => {
    const fileInput = document.getElementById('file');
    fileInput.addEventListener('change', (evt) => {
      console.log(evt)
      const file = evt.srcElement.files[0];
      const fileUrl = URL.createObjectURL(fileUrl);
    })
  }, 1000);  
}
