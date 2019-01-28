
import {
  DEFAULT_SCALE_VALUE,
  getPDFFileNameFromURL,
  parseQueryString
} from './ui_utils';
import {
  getDocument, getFilenameFromUrl, GlobalWorkerOptions, UNSUPPORTED_FEATURES,
  version
} from 'pdfjs-lib';
import { PDFRenderingQueue } from './pdf_rendering_queue';
import { PDFLinkService } from './pdf_link_service';
import { PDFViewer } from './pdf_viewer';

let PDFViewerApplication = {
  initialized: false,
  appConfig: null,
  pdfDocument: null,
  pdfLoadingTask: null,
  pdfViewer: null,
  /** @type {PDFRenderingQueue} */
  pdfRenderingQueue: null,
  /** @type {PDFLinkService} */
  pdfLinkService: null,

  // Called once when the document is loaded.
  async initialize(appConfig) {
    //this.preferences = this.externalServices.createPreferences();
    this.appConfig = appConfig;
    await this._initializeViewerComponents();
    this.initialized = true;
  },

  /**
   * @private
   */
  async _initializeViewerComponents() {
    const appConfig = this.appConfig;
    let pdfRenderingQueue = new PDFRenderingQueue();
    pdfRenderingQueue.onIdle = this.cleanup.bind(this);
    this.pdfRenderingQueue = pdfRenderingQueue;

    let pdfLinkService = new PDFLinkService({
      
    });
    this.pdfLinkService = pdfLinkService;

    const container = appConfig.mainContainer;
    const viewer = appConfig.viewerContainer;
    this.pdfViewer = new PDFViewer({
      container,
      viewer,
      renderingQueue: pdfRenderingQueue,
      linkService: pdfLinkService,
      renderer: 'canvas'
    });
    pdfRenderingQueue.setViewer(this.pdfViewer);
    pdfLinkService.setViewer(this.pdfViewer);
  },

  run(config) {
    this.initialize(config).then(webViewerInitialized);
  },
 
  /**
   * Closes opened PDF document.
   * @returns {Promise} - Returns the promise, which is resolved when all
   *                      destruction is completed.
   */
  async close() {

    if (!this.pdfLoadingTask) {
      return;
    }

    let promise = this.pdfLoadingTask.destroy();
    this.pdfLoadingTask = null;

    if (this.pdfDocument) {
      this.pdfDocument = null;
      this.pdfViewer.setDocument(null);
      this.pdfLinkService.setDocument(null);
    }
    this.isInitialViewSet = false;
    this.url = '';
    this.baseUrl = '';
    return promise;
  },
  async open(file, args) {
    if (this.pdfLoadingTask) {
      // We need to destroy already opened document.
      await this.close();
    }
    // Set the necessary global worker parameters, using the available options.
    const workerParameters = {
      workerPort: null,
      workerSrc: '../src/worker_loader.js'
    };
    for (let key in workerParameters) {
      GlobalWorkerOptions[key] = workerParameters[key];
    }
    let parameters = Object.create(null);
    parameters.url = file; // url

    let loadingTask = getDocument(parameters);
    this.pdfLoadingTask = loadingTask;

    return loadingTask.promise.then((pdfDocument) => {
      this.load(pdfDocument);
    }, () => {
      if (loadingTask !== this.pdfLoadingTask) {
        return; // Ignore errors for previously opened PDF files.
      }      
    });
  },

  load(pdfDocument) {
    this.pdfDocument = pdfDocument;

    // Since the `setInitialView` call below depends on this being resolved,
    // fetch it early to avoid delaying initial rendering of the PDF document.
    const pageModePromise = pdfDocument.getPageMode().catch(
      function() { /* Avoid breaking initial rendering; ignoring errors. */ });
    const openActionDestPromise = pdfDocument.getOpenActionDestination().catch(
      function() { /* Avoid breaking initial rendering; ignoring errors. */ });

    this.pdfLinkService.setDocument(pdfDocument, null);

    let pdfViewer = this.pdfViewer;
    pdfViewer.setDocument(pdfDocument);
    let firstPagePromise = pdfViewer.firstPagePromise;

    firstPagePromise.then(() => {
      Promise.all([
        pageModePromise, openActionDestPromise,
      ]).then(async () => {
        this.setInitialView();
        // eslint-disable-next-line no-self-assign
        pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
        // Re-apply the initial document location.
        this.setInitialView();
      }).catch(() => {
        // Ensure that the document is always completely initialized,
        // even if there are any errors thrown above.
        this.setInitialView();
      }).then(function () {
        // At this point, rendering of the initial page(s) should always have
        // started (and may even have completed).
        // To prevent any future issues, e.g. the document being completely
        // blank on load, always trigger rendering here.
        pdfViewer.update();
      });
    });
  },

  setInitialView() {
    this.isInitialViewSet = true;

    if (!this.pdfViewer.currentScaleValue) {
      // Scale was not initialized: invalid bookmark or scale was not specified.
      // Setting the default one.
      this.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    }
  },

  cleanup() {
    if (!this.pdfDocument) {
      return; // run cleanup when document is loaded
    }
    this.pdfViewer.cleanup();

    // We don't want to remove fonts used by active page SVGs.
    //if (this.pdfViewer.renderer !== RendererType.SVG) {
    //  this.pdfDocument.cleanup();
    //}
    this.pdfDocument.cleanup();
  }
};

function webViewerInitialized() {
  let file = 'compressed.tracemonkey-pldi-09.pdf';

  try {
    webViewerOpenFileViaURL(file);
  } catch (reason) {
    console.log('error')
    PDFViewerApplication.l10n.get('loading_error', null,
        'An error occurred while loading the PDF.').then((msg) => {
      PDFViewerApplication.error(msg, reason);
    });
  }
}

let webViewerOpenFileViaURL = function webViewerOpenFileViaURL(file) {
  if (file && file.lastIndexOf('file:', 0) === 0) {
    // file:-scheme. Load the contents in the main thread because QtWebKit
    // cannot load file:-URLs in a Web Worker. file:-URLs are usually loaded
    // very quickly, so there is no need to set up progress event listeners.
    PDFViewerApplication.setTitleUsingUrl(file);
    let xhr = new XMLHttpRequest();
    xhr.onload = function () {
      PDFViewerApplication.open(new Uint8Array(xhr.response));
    };
    try {
      xhr.open('GET', file);
      xhr.responseType = 'arraybuffer';
      xhr.send();
    } catch (ex) {
      throw ex;
    }
    return;
  }

  if (file) {
    PDFViewerApplication.open(file);
  }
};


export {
  PDFViewerApplication
};
