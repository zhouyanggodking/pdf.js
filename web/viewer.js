'use strict';

let gApp = null;

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
    SystemJS.import('pdfjs-web/app')
  ]).then(function ([app]) {
    gApp = app;
    window.PDFViewerApplication = app.PDFViewerApplication;
    app.PDFViewerApplication.run(config);
  });
}

if (document.readyState === 'interactive' ||
    document.readyState === 'complete') {
  webViewerLoad();
} else {
  document.addEventListener('DOMContentLoaded', webViewerLoad, true);
  setTimeout(() => {
    console.log('test')
    const fileInput = document.getElementById('file');
    fileInput.addEventListener('change', (evt) => {
      console.log(evt)
      const file = evt.srcElement.files[0];
      const fileUrl = URL.createObjectURL(file);
      let config = getViewerConfiguration();
      config.url = fileUrl;
      gApp.PDFViewerApplication.run(config);
    })
  }, 1000);  
}
