/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals PDFBug, Stats */

import {
  DEFAULT_SCALE_VALUE, getGlobalEventBus,
  getPDFFileNameFromURL, MAX_SCALE, MIN_SCALE,
  parseQueryString
} from './ui_utils';
import {
  build, createObjectURL, getDocument, getFilenameFromUrl, GlobalWorkerOptions,
  InvalidPDFException, LinkTarget, loadScript, MissingPDFException, OPS,
  PDFWorker, shadow, UnexpectedResponseException, UNSUPPORTED_FEATURES, URL,
  version
} from 'pdfjs-lib';
import { PDFRenderingQueue, RenderingStates } from './pdf_rendering_queue';
import { AppOptions } from './app_options';
import { PDFHistory } from './pdf_history';
import { PDFLinkService } from './pdf_link_service';
import { PDFViewer } from './pdf_viewer';

const DEFAULT_SCALE_DELTA = 1.1;
const FORCE_PAGES_LOADED_TIMEOUT = 10000; // ms
const WHEEL_ZOOM_DISABLED_TIMEOUT = 1000; // ms

const DefaultExternalServices = {
  updateFindControlState(data) {},
  updateFindMatchesCount(data) {},
  initPassiveLoading(callbacks) {},
  fallback(data, callback) {},
  reportTelemetry(data) {},
  createDownloadManager(options) {
    throw new Error('Not implemented: createDownloadManager');
  },
  createPreferences() {
    throw new Error('Not implemented: createPreferences');
  },
  createL10n(options) {
    throw new Error('Not implemented: createL10n');
  },
  supportsIntegratedFind: false,
  supportsDocumentFonts: true,
  supportsDocumentColors: true,
  supportedMouseWheelZoomModifierKeys: {
    ctrlKey: true,
    metaKey: true,
  },
};

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
    await this._parseHashParameters();
    await this._initializeViewerComponents();
    this.initialized = true;
  },

  /**
   * @private
   */
  async _parseHashParameters() {
    const waitOn = [];

    // Special debugging flags in the hash section of the URL.
    let hash = document.location.hash.substring(1);
    let hashParams = parseQueryString(hash);
 
    if ((typeof PDFJSDev === 'undefined' || !PDFJSDev.test('PRODUCTION')) &&
        hashParams['disablebcmaps'] === 'true') {
      AppOptions.set('cMapUrl', '../external/cmaps/');
      AppOptions.set('cMapPacked', false);
    }   

    return Promise.all(waitOn).catch((reason) => {
      console.error(`_parseHashParameters: "${reason.message}".`);
    });
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
        if (pageMode && !AppOptions.get('disablePageMode')) {
          // Always let the user preference/history take precedence.
          sidebarView = sidebarView || apiPageModeToSidebarView(pageMode);
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

let webViewerOpenFileViaURL;
if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
  console.log('king')
  webViewerOpenFileViaURL = function webViewerOpenFileViaURL(file) {
    if (file && file.lastIndexOf('file:', 0) === 0) {
      // file:-scheme. Load the contents in the main thread because QtWebKit
      // cannot load file:-URLs in a Web Worker. file:-URLs are usually loaded
      // very quickly, so there is no need to set up progress event listeners.
      PDFViewerApplication.setTitleUsingUrl(file);
      let xhr = new XMLHttpRequest();
      xhr.onload = function() {
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
}


function webViewerPresentationMode() {
  PDFViewerApplication.requestPresentationMode();
}
function webViewerOpenFile() {
  if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
    let openFileInputName = PDFViewerApplication.appConfig.openFileInputName;
    document.getElementById(openFileInputName).click();
  }
}
function webViewerPrint() {
  window.print();
}
function webViewerDownload() {
  PDFViewerApplication.download();
}
function webViewerFirstPage() {
  if (PDFViewerApplication.pdfDocument) {
    PDFViewerApplication.page = 1;
  }
}
function webViewerLastPage() {
  if (PDFViewerApplication.pdfDocument) {
    PDFViewerApplication.page = PDFViewerApplication.pagesCount;
  }
}
function webViewerNextPage() {
  PDFViewerApplication.page++;
}
function webViewerPreviousPage() {
  PDFViewerApplication.page--;
}
function webViewerZoomIn() {
  PDFViewerApplication.zoomIn();
}
function webViewerZoomOut() {
  PDFViewerApplication.zoomOut();
}
function webViewerPageNumberChanged(evt) {
  let pdfViewer = PDFViewerApplication.pdfViewer;
  // Note that for `<input type="number">` HTML elements, an empty string will
  // be returned for non-number inputs; hence we simply do nothing in that case.
  if (evt.value !== '') {
    pdfViewer.currentPageLabel = evt.value;
  }

}
function webViewerScaleChanged(evt) {
  PDFViewerApplication.pdfViewer.currentScaleValue = evt.value;
}
function webViewerRotateCw() {
  PDFViewerApplication.rotatePages(90);
}
function webViewerRotateCcw() {
  PDFViewerApplication.rotatePages(-90);
}
function webViewerSwitchScrollMode(evt) {
  PDFViewerApplication.pdfViewer.scrollMode = evt.mode;
}
function webViewerSwitchSpreadMode(evt) {
  PDFViewerApplication.pdfViewer.spreadMode = evt.mode;
}
function webViewerDocumentProperties() {
  PDFViewerApplication.pdfDocumentProperties.open();
}

function webViewerFind(evt) {
  PDFViewerApplication.findController.executeCommand('find' + evt.type, {
    query: evt.query,
    phraseSearch: evt.phraseSearch,
    caseSensitive: evt.caseSensitive,
    entireWord: evt.entireWord,
    highlightAll: evt.highlightAll,
    findPrevious: evt.findPrevious,
  });
}

function webViewerFindFromUrlHash(evt) {
  PDFViewerApplication.findController.executeCommand('find', {
    query: evt.query,
    phraseSearch: evt.phraseSearch,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: false,
  });
}

function webViewerUpdateFindMatchesCount({ matchesCount, }) {
  if (PDFViewerApplication.supportsIntegratedFind) {
    PDFViewerApplication.externalServices.updateFindMatchesCount(matchesCount);
  } else {
    PDFViewerApplication.findBar.updateResultsCount(matchesCount);
  }
}

function webViewerUpdateFindControlState({ state, previous, matchesCount, }) {
  if (PDFViewerApplication.supportsIntegratedFind) {
    PDFViewerApplication.externalServices.updateFindControlState({
      result: state,
      findPrevious: previous,
      matchesCount,
    });
  } else {
    PDFViewerApplication.findBar.updateUIState(state, previous, matchesCount);
  }
}

function webViewerScaleChanging(evt) {

  PDFViewerApplication.pdfViewer.update();
}

function webViewerRotationChanging(evt) {
  PDFViewerApplication.pdfThumbnailViewer.pagesRotation = evt.pagesRotation;

  PDFViewerApplication.forceRendering();
  // Ensure that the active page doesn't change during rotation.
  PDFViewerApplication.pdfViewer.currentPageNumber = evt.pageNumber;
}

function webViewerPageChanging(evt) {
  let page = evt.pageNumber;



 
}

function webViewerVisibilityChange(evt) {
  if (document.visibilityState === 'visible') {
    // Ignore mouse wheel zooming during tab switches (bug 1503412).
    setZoomDisabledTimeout();
  }
}

let zoomDisabledTimeout = null;
function setZoomDisabledTimeout() {
  if (zoomDisabledTimeout) {
    clearTimeout(zoomDisabledTimeout);
  }
  zoomDisabledTimeout = setTimeout(function() {
    zoomDisabledTimeout = null;
  }, WHEEL_ZOOM_DISABLED_TIMEOUT);
}

function webViewerWheel(evt) {
  let pdfViewer = PDFViewerApplication.pdfViewer;
  if (pdfViewer.isInPresentationMode) {
    return;
  }

  if (evt.ctrlKey || evt.metaKey) {
    let support = PDFViewerApplication.supportedMouseWheelZoomModifierKeys;
    if ((evt.ctrlKey && !support.ctrlKey) ||
        (evt.metaKey && !support.metaKey)) {
      return;
    }
    // Only zoom the pages, not the entire viewer.
    evt.preventDefault();
    // NOTE: this check must be placed *after* preventDefault.
    if (zoomDisabledTimeout || document.visibilityState === 'hidden') {
      return;
    }

    let previousScale = pdfViewer.currentScale;

    let delta = normalizeWheelEventDelta(evt);

    const MOUSE_WHEEL_DELTA_PER_PAGE_SCALE = 3.0;
    let ticks = delta * MOUSE_WHEEL_DELTA_PER_PAGE_SCALE;
    if (ticks < 0) {
      PDFViewerApplication.zoomOut(-ticks);
    } else {
      PDFViewerApplication.zoomIn(ticks);
    }

    let currentScale = pdfViewer.currentScale;
    if (previousScale !== currentScale) {
      // After scaling the page via zoomIn/zoomOut, the position of the upper-
      // left corner is restored. When the mouse wheel is used, the position
      // under the cursor should be restored instead.
      let scaleCorrectionFactor = currentScale / previousScale - 1;
      let rect = pdfViewer.container.getBoundingClientRect();
      let dx = evt.clientX - rect.left;
      let dy = evt.clientY - rect.top;
      pdfViewer.container.scrollLeft += dx * scaleCorrectionFactor;
      pdfViewer.container.scrollTop += dy * scaleCorrectionFactor;
    }
  } else {
    setZoomDisabledTimeout();
  }
}

function webViewerClick(evt) {
}

function webViewerKeyDown(evt) {
  if (PDFViewerApplication.overlayManager.active) {
    return;
  }

  let handled = false, ensureViewerFocused = false;
  let cmd = (evt.ctrlKey ? 1 : 0) |
            (evt.altKey ? 2 : 0) |
            (evt.shiftKey ? 4 : 0) |
            (evt.metaKey ? 8 : 0);

  let pdfViewer = PDFViewerApplication.pdfViewer;
  let isViewerInPresentationMode = pdfViewer && pdfViewer.isInPresentationMode;

  // First, handle the key bindings that are independent whether an input
  // control is selected or not.
  if (cmd === 1 || cmd === 8 || cmd === 5 || cmd === 12) {
    // either CTRL or META key with optional SHIFT.
    switch (evt.keyCode) {
      case 70: // f
        if (!PDFViewerApplication.supportsIntegratedFind) {
          PDFViewerApplication.findBar.open();
          handled = true;
        }
        break;
      case 71: // g
        if (!PDFViewerApplication.supportsIntegratedFind) {
          let findState = PDFViewerApplication.findController.state;
          if (findState) {
            PDFViewerApplication.findController.executeCommand('findagain', {
              query: findState.query,
              phraseSearch: findState.phraseSearch,
              caseSensitive: findState.caseSensitive,
              entireWord: findState.entireWord,
              highlightAll: findState.highlightAll,
              findPrevious: cmd === 5 || cmd === 12,
            });
          }
          handled = true;
        }
        break;
      case 61: // FF/Mac '='
      case 107: // FF '+' and '='
      case 187: // Chrome '+'
      case 171: // FF with German keyboard
        if (!isViewerInPresentationMode) {
          PDFViewerApplication.zoomIn();
        }
        handled = true;
        break;
      case 173: // FF/Mac '-'
      case 109: // FF '-'
      case 189: // Chrome '-'
        if (!isViewerInPresentationMode) {
          PDFViewerApplication.zoomOut();
        }
        handled = true;
        break;
      case 48: // '0'
      case 96: // '0' on Numpad of Swedish keyboard
        if (!isViewerInPresentationMode) {
          // keeping it unhandled (to restore page zoom to 100%)
          setTimeout(function () {
            // ... and resetting the scale after browser adjusts its scale
            pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
          });
          handled = false;
        }
        break;

      case 38: // up arrow
        if (isViewerInPresentationMode || PDFViewerApplication.page > 1) {
          PDFViewerApplication.page = 1;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
      case 40: // down arrow
        if (isViewerInPresentationMode ||
            PDFViewerApplication.page < PDFViewerApplication.pagesCount) {
          PDFViewerApplication.page = PDFViewerApplication.pagesCount;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
    }
  }

  if (typeof PDFJSDev === 'undefined' ||
      !PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
    // CTRL or META without shift
    if (cmd === 1 || cmd === 8) {
      switch (evt.keyCode) {
        case 83: // s
          PDFViewerApplication.download();
          handled = true;
          break;
      }
    }
  }

  // CTRL+ALT or Option+Command
  if (cmd === 3 || cmd === 10) {
    switch (evt.keyCode) {
      case 80: // p
        PDFViewerApplication.requestPresentationMode();
        handled = true;
        break;
      case 71: // g
        // focuses input#pageNumber field
        handled = true;
        break;
    }
  }

  if (handled) {
    if (ensureViewerFocused && !isViewerInPresentationMode) {
      pdfViewer.focus();
    }
    evt.preventDefault();
    return;
  }

  // Some shortcuts should not get handled if a control/input element
  // is selected.
  let curElement = document.activeElement || document.querySelector(':focus');
  let curElementTagName = curElement && curElement.tagName.toUpperCase();
  if (curElementTagName === 'INPUT' ||
      curElementTagName === 'TEXTAREA' ||
      curElementTagName === 'SELECT') {
    // Make sure that the secondary toolbar is closed when Escape is pressed.
    if (evt.keyCode !== 27) { // 'Esc'
      return;
    }
  }

  if (cmd === 0) { // no control key pressed at all.
    let turnPage = 0, turnOnlyIfPageFit = false;
    switch (evt.keyCode) {
      case 38: // up arrow
      case 33: // pg up
        // vertical scrolling using arrow/pg keys
        if (pdfViewer.isVerticalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
        turnPage = -1;
        break;
      case 8: // backspace
        if (!isViewerInPresentationMode) {
          turnOnlyIfPageFit = true;
        }
        turnPage = -1;
        break;
      case 37: // left arrow
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
        /* falls through */
      case 75: // 'k'
      case 80: // 'p'
        turnPage = -1;
        break;
      case 27: // esc key
        
        break;
      case 40: // down arrow
      case 34: // pg down
        // vertical scrolling using arrow/pg keys
        if (pdfViewer.isVerticalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
        turnPage = 1;
        break;
      case 13: // enter key
      case 32: // spacebar
        if (!isViewerInPresentationMode) {
          turnOnlyIfPageFit = true;
        }
        turnPage = 1;
        break;
      case 39: // right arrow
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          turnOnlyIfPageFit = true;
        }
        /* falls through */
      case 74: // 'j'
      case 78: // 'n'
        turnPage = 1;
        break;

      case 36: // home
        if (isViewerInPresentationMode || PDFViewerApplication.page > 1) {
          PDFViewerApplication.page = 1;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
      case 35: // end
        if (isViewerInPresentationMode ||
            PDFViewerApplication.page < PDFViewerApplication.pagesCount) {
          PDFViewerApplication.page = PDFViewerApplication.pagesCount;
          handled = true;
          ensureViewerFocused = true;
        }
        break;

      case 83: // 's'
        break;
      case 72: // 'h'
        break;

      case 82: // 'r'
        PDFViewerApplication.rotatePages(90);
        break;

      case 115: // F4
        break;
    }

    if (turnPage !== 0 &&
        (!turnOnlyIfPageFit || pdfViewer.currentScaleValue === 'page-fit')) {
      if (turnPage > 0) {
        if (PDFViewerApplication.page < PDFViewerApplication.pagesCount) {
          PDFViewerApplication.page++;
        }
      } else {
        if (PDFViewerApplication.page > 1) {
          PDFViewerApplication.page--;
        }
      }
      handled = true;
    }
  }

  if (cmd === 4) { // shift-key
    switch (evt.keyCode) {
      case 13: // enter key
      case 32: // spacebar
        if (!isViewerInPresentationMode &&
            pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        if (PDFViewerApplication.page > 1) {
          PDFViewerApplication.page--;
        }
        handled = true;
        break;

      case 82: // 'r'
        PDFViewerApplication.rotatePages(-90);
        break;
    }
  }

  if (!handled && !isViewerInPresentationMode) {
    // 33=Page Up  34=Page Down  35=End    36=Home
    // 37=Left     38=Up         39=Right  40=Down
    // 32=Spacebar
    if ((evt.keyCode >= 33 && evt.keyCode <= 40) ||
        (evt.keyCode === 32 && curElementTagName !== 'BUTTON')) {
      ensureViewerFocused = true;
    }
  }

  if (ensureViewerFocused && !pdfViewer.containsElement(curElement)) {
    // The page container is not focused, but a page navigation key has been
    // pressed. Change the focus to the viewer container to make sure that
    // navigation by keyboard works as expected.
    pdfViewer.focus();
  }

  if (handled) {
    evt.preventDefault();
  }
}

/**
 * Converts API PageMode values to the format used by `PDFSidebar`.
 * NOTE: There's also a "FullScreen" parameter which is not possible to support,
 *       since the Fullscreen API used in browsers requires that entering
 *       fullscreen mode only occurs as a result of a user-initiated event.
 * @param {string} mode - The API PageMode value.
 * @returns {number} A value from {SidebarView}.
 */
function apiPageModeToSidebarView(mode) {
  switch (mode) {
    case 'UseNone':
      return SidebarView.NONE;
    case 'UseThumbs':
      return SidebarView.THUMBS;
    case 'UseOutlines':
      return SidebarView.OUTLINE;
    case 'UseAttachments':
      return SidebarView.ATTACHMENTS;
    case 'UseOC':
      // Not implemented, since we don't support Optional Content Groups yet.
  }
  return SidebarView.NONE; // Default value.
}

/* Abstract factory for the print service. */
let PDFPrintServiceFactory = {
  instance: {
    supportsPrinting: false,
    createPrintService() {
      throw new Error('Not implemented: createPrintService');
    },
  },
};

export {
  PDFViewerApplication,
  DefaultExternalServices,
  PDFPrintServiceFactory,
};
