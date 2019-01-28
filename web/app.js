
import {
  DEFAULT_SCALE_VALUE,
  getPDFFileNameFromURL,
  parseQueryString
} from './ui_utils';
import {
  getDocument, getFilenameFromUrl, GlobalWorkerOptions,
  InvalidPDFException,  MissingPDFException, 
  UnexpectedResponseException, UNSUPPORTED_FEATURES,
  version
} from 'pdfjs-lib';
import { PDFRenderingQueue } from './pdf_rendering_queue';
import { AppOptions } from './app_options';
import { PDFLinkService } from './pdf_link_service';
import { PDFViewer } from './pdf_viewer';;
const FORCE_PAGES_LOADED_TIMEOUT = 10000; // ms

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
  
  /** @type {EventBus} */
  eventBus: null,
  url: '',
  baseUrl: '',

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
      externalLinkTarget: AppOptions.get('externalLinkTarget'),
      externalLinkRel: AppOptions.get('externalLinkRel'),
    });
    this.pdfLinkService = pdfLinkService;

    const container = appConfig.mainContainer;
    const viewer = appConfig.viewerContainer;
    this.pdfViewer = new PDFViewer({
      container,
      viewer,
      renderingQueue: pdfRenderingQueue,
      linkService: pdfLinkService,
      renderer: AppOptions.get('renderer')
    });
    pdfRenderingQueue.setViewer(this.pdfViewer);
    pdfLinkService.setViewer(this.pdfViewer);
  },

  run(config) {
    this.initialize(config).then(webViewerInitialized);
  },

  get pagesCount() {
    return this.pdfDocument ? this.pdfDocument.numPages : 0;
  },

  set page(val) {
    this.pdfViewer.currentPageNumber = val;
  },

  get page() {
    return this.pdfViewer.currentPageNumber;
  },

  setTitleUsingUrl(url = '') {
    this.url = url;
    this.baseUrl = url.split('#')[0];
    let title = getPDFFileNameFromURL(url, '');
    if (!title) {
      try {
        title = decodeURIComponent(getFilenameFromUrl(url)) || url;
      } catch (ex) {
        // decodeURIComponent may throw URIError,
        // fall back to using the unprocessed url in that case
        title = url;
      }
    }
    this.setTitle(title);
  },

  setTitle(title) {
    if (this.isViewerEmbedded) {
      // Embedded PDF viewers should not be changing their parent page's title.
      return;
    }
    document.title = title;
  },

  /**
   * Closes opened PDF document.
   * @returns {Promise} - Returns the promise, which is resolved when all
   *                      destruction is completed.
   */
  async close() {
    let errorWrapper = this.appConfig.errorWrapper.container;
    errorWrapper.setAttribute('hidden', 'true');

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
    this.store = null;
    this.isInitialViewSet = false;
    this.downloadComplete = false;
    this.url = '';
    this.baseUrl = '';
    this.contentDispositionFilename = null;
    
    if (typeof PDFBug !== 'undefined') {
      PDFBug.cleanup();
    }
    return promise;
  },

  /**
   * Opens PDF document specified by URL or array with additional arguments.
   * @param {string|TypedArray|ArrayBuffer} file - PDF location or binary data.
   * @param {Object} args - (optional) Additional arguments for the getDocument
   *                        call, e.g. HTTP headers ('httpHeaders') or
   *                        alternative data transport ('range').
   * @returns {Promise} - Returns the promise, which is resolved when document
   *                      is opened.
   */
  async open(file, args) {
    if (this.pdfLoadingTask) {
      // We need to destroy already opened document.
      await this.close();
    }
    // Set the necessary global worker parameters, using the available options.
    const workerParameters = AppOptions.getAll('worker');
    for (let key in workerParameters) {
      GlobalWorkerOptions[key] = workerParameters[key];
    }

    let parameters = Object.create(null);
    if (typeof file === 'string') { // URL
      this.setTitleUsingUrl(file);
      parameters.url = file;
    } else if (file && 'byteLength' in file) { // ArrayBuffer
      parameters.data = file;
    } else if (file.url && file.originalUrl) {
      this.setTitleUsingUrl(file.originalUrl);
      parameters.url = file.url;
    }
    if (typeof PDFJSDev === 'undefined' || !PDFJSDev.test('PRODUCTION')) {
      parameters.docBaseUrl = document.URL.split('#')[0];
    } else if (typeof PDFJSDev !== 'undefined' &&
               PDFJSDev.test('FIREFOX || MOZCENTRAL || CHROME')) {
      parameters.docBaseUrl = this.baseUrl;
    }
    // Set the necessary API parameters, using the available options.
    const apiParameters = AppOptions.getAll('api');
    for (let key in apiParameters) {
      parameters[key] = apiParameters[key];
    }

    if (args) {
      for (let prop in args) {
        if (prop === 'length') {
          this.pdfDocumentProperties.setFileSize(args[prop]);
        }
        parameters[prop] = args[prop];
      }
    }

    let loadingTask = getDocument(parameters);
    this.pdfLoadingTask = loadingTask;

    return loadingTask.promise.then((pdfDocument) => {
      this.load(pdfDocument);
    }, (exception) => {
      if (loadingTask !== this.pdfLoadingTask) {
        return; // Ignore errors for previously opened PDF files.
      }

      let message = exception && exception.message;
      let loadingErrorMessage;
      if (exception instanceof InvalidPDFException) {
        // change error message also for other builds
        loadingErrorMessage = this.l10n.get('invalid_file_error', null,
                                            'Invalid or corrupted PDF file.');
      } else if (exception instanceof MissingPDFException) {
        // special message for missing PDF's
        loadingErrorMessage = this.l10n.get('missing_file_error', null,
                                            'Missing PDF file.');
      } else if (exception instanceof UnexpectedResponseException) {
        loadingErrorMessage = this.l10n.get('unexpected_response_error', null,
                                            'Unexpected server response.');
      } else {
        loadingErrorMessage = this.l10n.get('loading_error', null,
          'An error occurred while loading the PDF.');
      }

      return loadingErrorMessage.then((msg) => {
        this.error(msg, { message, });
        throw new Error(msg);
      });
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


    let baseDocumentUrl;
    if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
      baseDocumentUrl = null;
    } else if (PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
      baseDocumentUrl = this.baseUrl;
    } else if (PDFJSDev.test('CHROME')) {
      baseDocumentUrl = location.href.split('#')[0];
    }
    this.pdfLinkService.setDocument(pdfDocument, baseDocumentUrl);

    let pdfViewer = this.pdfViewer;
    pdfViewer.setDocument(pdfDocument);
    let firstPagePromise = pdfViewer.firstPagePromise;
    let pagesPromise = pdfViewer.pagesPromise;
    let onePageRendered = pdfViewer.onePageRendered;

    firstPagePromise.then((pdfPage) => {

      if (!AppOptions.get('disableHistory') && !this.isViewerEmbedded) {
      }

      Promise.all([
        pageModePromise, openActionDestPromise,
      ]).then(async ([pageMode, openActionDest]) => {
        let values = {};
        if (openActionDest && !this.initialBookmark &&
            !AppOptions.get('disableOpenActionDestination')) {
          // Always let the browser history/document hash take precedence.
          this.initialBookmark = JSON.stringify(openActionDest);
          // TODO: Re-factor the `PDFHistory` initialization to remove this hack
          // that's currently necessary to prevent weird initial history state.
          this.pdfHistory.push({ explicitDest: openActionDest,
                                 pageNumber: null, });
        }
        const initialBookmark = this.initialBookmark;
        // Initialize the default values, from user preferences.
        const zoom = AppOptions.get('defaultZoomValue');
        let hash = zoom ? `zoom=${zoom}` : null;

        let rotation = null;
        let sidebarView = AppOptions.get('sidebarViewOnLoad');
        let scrollMode = AppOptions.get('scrollModeOnLoad');
        let spreadMode = AppOptions.get('spreadModeOnLoad');

        if (values.page && AppOptions.get('showPreviousViewOnLoad')) {
          hash = 'page=' + values.page + '&zoom=' + (zoom || values.zoom) +
            ',' + values.scrollLeft + ',' + values.scrollTop;

          rotation = parseInt(values.rotation, 10);
          sidebarView = sidebarView || (values.sidebarView | 0);
          scrollMode = scrollMode || (values.scrollMode | 0);
          spreadMode = spreadMode || (values.spreadMode | 0);
        }

        this.setInitialView(hash, {
          rotation, sidebarView, scrollMode, spreadMode,
        });
        // Make all navigation keys work on document load,
        // unless the viewer is embedded in a web page.
        if (!this.isViewerEmbedded) {
          pdfViewer.focus();
        }

        // For documents with different page sizes, once all pages are resolved,
        // ensure that the correct location becomes visible on load.
        // (To reduce the risk, in very large and/or slow loading documents,
        //  that the location changes *after* the user has started interacting
        //  with the viewer, wait for either `pagesPromise` or a timeout.)
        await Promise.race([
          pagesPromise,
          new Promise((resolve) => {
            setTimeout(resolve, FORCE_PAGES_LOADED_TIMEOUT);
          }),
        ]);
        if (!initialBookmark && !hash) {
          return;
        }
        if (pdfViewer.hasEqualPageSizes) {
          return;
        }
        this.initialBookmark = initialBookmark;

        // eslint-disable-next-line no-self-assign
        pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
        // Re-apply the initial document location.
        this.setInitialView(hash);
      }).catch(() => {
        // Ensure that the document is always completely initialized,
        // even if there are any errors thrown above.
        this.setInitialView();
      }).then(function() {
        // At this point, rendering of the initial page(s) should always have
        // started (and may even have completed).
        // To prevent any future issues, e.g. the document being completely
        // blank on load, always trigger rendering here.
        pdfViewer.update();
      });
    });

    pdfDocument.getPageLabels().then((labels) => {
      if (!labels || AppOptions.get('disablePageLabels')) {
        return;
      }
      let i = 0, numLabels = labels.length;
      if (numLabels !== this.pagesCount) {
        console.error('The number of Page Labels does not match ' +
                      'the number of pages in the document.');
        return;
      }
      // Ignore page labels that correspond to standard page numbering.
      while (i < numLabels && labels[i] === (i + 1).toString()) {
        i++;
      }
      if (i === numLabels) {
        return;
      }

      pdfViewer.setPageLabels(labels);
      pdfThumbnailViewer.setPageLabels(labels);
    });

    pagesPromise.then(() => {
      if (!this.supportsPrinting) {
        return;
      }
      pdfDocument.getJavaScript().then((javaScript) => {
        if (!javaScript) {
          return;
        }
        javaScript.some((js) => {
          if (!js) { // Don't warn/fallback for empty JavaScript actions.
            return false;
          }
          console.warn('Warning: JavaScript is not supported');
          this.fallback(UNSUPPORTED_FEATURES.javaScript);
          return true;
        });

        // Hack to support auto printing.
        let regex = /\bprint\s*\(/;
        for (let i = 0, ii = javaScript.length; i < ii; i++) {
          let js = javaScript[i];
          if (js && regex.test(js)) {
            setTimeout(function() {
              window.print();
            });
            return;
          }
        }
      });
    });


    pdfDocument.getMetadata().then(
        ({ info, metadata, contentDispositionFilename, }) => {
      this.documentInfo = info;
      this.metadata = metadata;
      this.contentDispositionFilename = contentDispositionFilename;

      // Provides some basic debug information
      console.log('PDF ' + pdfDocument.fingerprint + ' [' +
                  info.PDFFormatVersion + ' ' + (info.Producer || '-').trim() +
                  ' / ' + (info.Creator || '-').trim() + ']' +
                  ' (PDF.js: ' + (version || '-') +
                  (AppOptions.get('enableWebGL') ? ' [WebGL]' : '') + ')');

      let pdfTitle;
      if (metadata && metadata.has('dc:title')) {
        let title = metadata.get('dc:title');
        // Ghostscript sometimes return 'Untitled', sets the title to 'Untitled'
        if (title !== 'Untitled') {
          pdfTitle = title;
        }
      }

      if (!pdfTitle && info && info['Title']) {
        pdfTitle = info['Title'];
      }

      if (pdfTitle) {
        this.setTitle(
          `${pdfTitle} - ${contentDispositionFilename || document.title}`);
      } else if (contentDispositionFilename) {
        this.setTitle(contentDispositionFilename);
      }

      if (info.IsAcroFormPresent) {
        console.warn('Warning: AcroForm/XFA is not supported');
        this.fallback(UNSUPPORTED_FEATURES.forms);
      }

      if (typeof PDFJSDev !== 'undefined' &&
          PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
        let versionId = String(info.PDFFormatVersion).slice(-1) | 0;
        let generatorId = 0;
        const KNOWN_GENERATORS = [
          'acrobat distiller', 'acrobat pdfwriter', 'adobe livecycle',
          'adobe pdf library', 'adobe photoshop', 'ghostscript', 'tcpdf',
          'cairo', 'dvipdfm', 'dvips', 'pdftex', 'pdfkit', 'itext', 'prince',
          'quarkxpress', 'mac os x', 'microsoft', 'openoffice', 'oracle',
          'luradocument', 'pdf-xchange', 'antenna house', 'aspose.cells', 'fpdf'
        ];
        if (info.Producer) {
          KNOWN_GENERATORS.some(function (generator, s, i) {
            if (!generator.includes(s)) {
              return false;
            }
            generatorId = i + 1;
            return true;
          }.bind(null, info.Producer.toLowerCase()));
        }
        let formType = !info.IsAcroFormPresent ? null : info.IsXFAPresent ?
                      'xfa' : 'acroform';
        this.externalServices.reportTelemetry({
          type: 'documentInfo',
          version: versionId,
          generator: generatorId,
          formType,
        });
      }
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
  let file = AppOptions.get('defaultUrl');

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
