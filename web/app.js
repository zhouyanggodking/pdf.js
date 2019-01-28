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
  initialBookmark: document.location.hash.substring(1),
  initialized: false,
  fellback: false,
  appConfig: null,
  pdfDocument: null,
  pdfLoadingTask: null,
  printService: null,
  /** @type {PDFViewer} */
  pdfViewer: null,
  /** @type {PDFThumbnailViewer} */
  pdfThumbnailViewer: null,
  /** @type {PDFRenderingQueue} */
  pdfRenderingQueue: null,
  /** @type {PDFPresentationMode} */
  pdfPresentationMode: null,
  /** @type {PDFDocumentProperties} */
  pdfDocumentProperties: null,
  /** @type {PDFLinkService} */
  pdfLinkService: null,
  /** @type {PDFHistory} */
  pdfHistory: null,
  /** @type {PDFSidebar} */
  pdfSidebar: null,
  /** @type {PDFSidebarResizer} */
  pdfSidebarResizer: null,
  /** @type {PDFOutlineViewer} */
  pdfOutlineViewer: null,
  /** @type {PDFAttachmentViewer} */
  pdfAttachmentViewer: null,
  /** @type {PDFCursorTools} */
  pdfCursorTools: null,
  /** @type {ViewHistory} */
  store: null,
  /** @type {DownloadManager} */
  downloadManager: null,
  /** @type {OverlayManager} */
  overlayManager: null,
  /** @type {Preferences} */
  preferences: null,
  /** @type {Toolbar} */
  toolbar: null,
  /** @type {SecondaryToolbar} */
  secondaryToolbar: null,
  /** @type {EventBus} */
  eventBus: null,
  /** @type {IL10n} */
  l10n: null,
  isInitialViewSet: false,
  downloadComplete: false,
  isViewerEmbedded: (window.parent !== window),
  url: '',
  baseUrl: '',
  externalServices: DefaultExternalServices,
  _boundEvents: {},
  contentDispositionFilename: null,

  // Called once when the document is loaded.
  async initialize(appConfig) {
    //this.preferences = this.externalServices.createPreferences();
    this.appConfig = appConfig;
    await this._parseHashParameters();
    await this._initializeL10n();

    if (this.isViewerEmbedded &&
        AppOptions.get('externalLinkTarget') === LinkTarget.NONE) {
      // Prevent external links from "replacing" the viewer,
      // when it's embedded in e.g. an <iframe> or an <object>.
      AppOptions.set('externalLinkTarget', LinkTarget.TOP);
    }
    await this._initializeViewerComponents();

    
    // We can start UI localization now.
    let appContainer = appConfig.appContainer || document.documentElement;
    this.l10n.translate(appContainer).then(() => {
      // Dispatch the 'localized' event on the `eventBus` once the viewer
      // has been fully initialized and translated.
      this.eventBus.dispatch('localized', { source: this, });
    });

    this.initialized = true;
  },

  /**
   * @private
   */
  async _parseHashParameters() {
    if (typeof PDFJSDev !== 'undefined' && PDFJSDev.test('PRODUCTION') &&
        !AppOptions.get('pdfBugEnabled')) {
      return;
    }
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
  async _initializeL10n() {
    this.l10n = this.externalServices.createL10n({
      locale: AppOptions.get('locale'),
    });
    const dir = await this.l10n.getDirection();
    document.getElementsByTagName('html')[0].dir = dir;
  },

  /**
   * @private
   */
  async _initializeViewerComponents() {
    const appConfig = this.appConfig;

    const dispatchToDOM = AppOptions.get('eventBusDispatchToDOM');
    const eventBus = appConfig.eventBus || getGlobalEventBus(dispatchToDOM);
    this.eventBus = eventBus;

    let pdfRenderingQueue = new PDFRenderingQueue();
    //pdfRenderingQueue.onIdle = this.cleanup.bind(this);
    this.pdfRenderingQueue = pdfRenderingQueue;

    let pdfLinkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: AppOptions.get('externalLinkTarget'),
      externalLinkRel: AppOptions.get('externalLinkRel'),
    });
    this.pdfLinkService = pdfLinkService;

    const container = appConfig.mainContainer;
    const viewer = appConfig.viewerContainer;
    this.pdfViewer = new PDFViewer({
      container,
      viewer,
      eventBus,
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

  zoomIn(ticks) {
    let newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.ceil(newScale * 10) / 10;
      newScale = Math.min(MAX_SCALE, newScale);
    } while (--ticks > 0 && newScale < MAX_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  zoomOut(ticks) {
    let newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.floor(newScale * 10) / 10;
      newScale = Math.max(MIN_SCALE, newScale);
    } while (--ticks > 0 && newScale > MIN_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
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

  get printing() {
    return !!this.printService;
  },

  get supportsPrinting() {
    return PDFPrintServiceFactory.instance.supportsPrinting;
  },

  get supportsFullscreen() {
    let support;
    if (typeof PDFJSDev !== 'undefined' && PDFJSDev.test('MOZCENTRAL')) {
      support = document.fullscreenEnabled === true ||
                document.mozFullScreenEnabled === true;
    } else {
      let doc = document.documentElement;
      support = !!(doc.requestFullscreen || doc.mozRequestFullScreen ||
                   doc.webkitRequestFullScreen || doc.msRequestFullscreen);

      if (document.fullscreenEnabled === false ||
          document.mozFullScreenEnabled === false ||
          document.webkitFullscreenEnabled === false ||
          document.msFullscreenEnabled === false) {
        support = false;
      }
    }
    return shadow(this, 'supportsFullscreen', support);
  },

  get supportsIntegratedFind() {
    return this.externalServices.supportsIntegratedFind;
  },

  get supportsDocumentFonts() {
    return this.externalServices.supportsDocumentFonts;
  },

  get supportsDocumentColors() {
    return this.externalServices.supportsDocumentColors;
  },

  get loadingBar() {
    return null
  },

  get supportedMouseWheelZoomModifierKeys() {
    return this.externalServices.supportedMouseWheelZoomModifierKeys;
  },

  initPassiveLoading() {
    if (typeof PDFJSDev === 'undefined' ||
        !PDFJSDev.test('FIREFOX || MOZCENTRAL || CHROME')) {
      throw new Error('Not implemented: initPassiveLoading');
    }
    this.externalServices.initPassiveLoading({
      onOpenWithTransport(url, length, transport) {
        PDFViewerApplication.open(url, { range: transport, });

        if (length) {
          PDFViewerApplication.pdfDocumentProperties.setFileSize(length);
        }
      },
      onOpenWithData(data) {
        PDFViewerApplication.open(data);
      },
      onOpenWithURL(url, length, originalUrl) {
        let file = url, args = null;
        if (length !== undefined) {
          args = { length, };
        }
        if (originalUrl !== undefined) {
          file = { url, originalUrl, };
        }
        PDFViewerApplication.open(file, args);
      },
      onError(err) {
        PDFViewerApplication.l10n.get('loading_error', null,
            'An error occurred while loading the PDF.').then((msg) => {
          PDFViewerApplication.error(msg, err);
        });
      },
      onProgress(loaded, total) {
        PDFViewerApplication.progress(loaded / total);
      },
    });
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

    loadingTask.onPassword = (updateCallback, reason) => {
      this.passwordPrompt.setUpdateCallback(updateCallback, reason);
      this.passwordPrompt.open();
    };

    loadingTask.onProgress = ({ loaded, total, }) => {
      this.progress(loaded / total);
    };

    // Listen for unsupported features to trigger the fallback UI.
    loadingTask.onUnsupportedFeature = this.fallback.bind(this);

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

  download() {
    function downloadByUrl() {
      downloadManager.downloadUrl(url, filename);
    }

    let url = this.baseUrl;
    // Use this.url instead of this.baseUrl to perform filename detection based
    // on the reference fragment as ultimate fallback if needed.
    let filename = this.contentDispositionFilename ||
      getPDFFileNameFromURL(this.url);
    let downloadManager = this.downloadManager;
    downloadManager.onerror = (err) => {
      // This error won't really be helpful because it's likely the
      // fallback won't work either (or is already open).
      this.error(`PDF failed to download: ${err}`);
    };

    // When the PDF document isn't ready, or the PDF file is still downloading,
    // simply download using the URL.
    if (!this.pdfDocument || !this.downloadComplete) {
      downloadByUrl();
      return;
    }

    this.pdfDocument.getData().then(function(data) {
      const blob = new Blob([data], { type: 'application/pdf', });
      downloadManager.download(blob, url, filename);
    }).catch(downloadByUrl); // Error occurred, try downloading with the URL.
  },

  fallback(featureId) {
    if (typeof PDFJSDev !== 'undefined' &&
        PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
      // Only trigger the fallback once so we don't spam the user with messages
      // for one PDF.
      if (this.fellback) {
        return;
      }
      this.fellback = true;
      this.externalServices.fallback({
        featureId,
        url: this.baseUrl,
      }, function response(download) {
        if (!download) {
          return;
        }
        PDFViewerApplication.download();
      });
    }
  },

  /**
   * Show the error box.
   * @param {String} message A message that is human readable.
   * @param {Object} moreInfo (optional) Further information about the error
   *                            that is more technical.  Should have a 'message'
   *                            and optionally a 'stack' property.
   */
  error(message, moreInfo) {
    let moreInfoText = [this.l10n.get('error_version_info',
      { version: version || '?', build: build || '?', },
      'PDF.js v{{version}} (build: {{build}})')];
    if (moreInfo) {
      moreInfoText.push(
        this.l10n.get('error_message', { message: moreInfo.message, },
                      'Message: {{message}}'));
      if (moreInfo.stack) {
        moreInfoText.push(
          this.l10n.get('error_stack', { stack: moreInfo.stack, },
                        'Stack: {{stack}}'));
      } else {
        if (moreInfo.filename) {
          moreInfoText.push(
            this.l10n.get('error_file', { file: moreInfo.filename, },
                          'File: {{file}}'));
        }
        if (moreInfo.lineNumber) {
          moreInfoText.push(
            this.l10n.get('error_line', { line: moreInfo.lineNumber, },
                          'Line: {{line}}'));
        }
      }
    }

    if (typeof PDFJSDev === 'undefined' ||
        !PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
      let errorWrapperConfig = this.appConfig.errorWrapper;
      let errorWrapper = errorWrapperConfig.container;
      errorWrapper.removeAttribute('hidden');

      let errorMessage = errorWrapperConfig.errorMessage;
      errorMessage.textContent = message;

      let closeButton = errorWrapperConfig.closeButton;
      closeButton.onclick = function() {
        errorWrapper.setAttribute('hidden', 'true');
      };

      let errorMoreInfo = errorWrapperConfig.errorMoreInfo;
      let moreInfoButton = errorWrapperConfig.moreInfoButton;
      let lessInfoButton = errorWrapperConfig.lessInfoButton;
      moreInfoButton.onclick = function() {
        errorMoreInfo.removeAttribute('hidden');
        moreInfoButton.setAttribute('hidden', 'true');
        lessInfoButton.removeAttribute('hidden');
        errorMoreInfo.style.height = errorMoreInfo.scrollHeight + 'px';
      };
      lessInfoButton.onclick = function() {
        errorMoreInfo.setAttribute('hidden', 'true');
        moreInfoButton.removeAttribute('hidden');
        lessInfoButton.setAttribute('hidden', 'true');
      };
      moreInfoButton.removeAttribute('hidden');
      lessInfoButton.setAttribute('hidden', 'true');
      Promise.all(moreInfoText).then((parts) => {
        errorMoreInfo.value = parts.join('\n');
      });
    } else {
      Promise.all(moreInfoText).then((parts) => {
        console.error(message + '\n' + parts.join('\n'));
      });
      this.fallback();
    }
  },

  progress(level) {
    if (this.downloadComplete) {
      // Don't accidentally show the loading bar again when the entire file has
      // already been fetched (only an issue when disableAutoFetch is enabled).
      return;
    }
    let percent = Math.round(level * 100);
  },

  load(pdfDocument) {
    this.pdfDocument = pdfDocument;

    pdfDocument.getDownloadInfo().then(() => {
      this.downloadComplete = true;
      firstPagePromise.then(() => {
        this.eventBus.dispatch('documentloaded', { source: this, });
      });
    });

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
        this.eventBus.dispatch('documentinit', { source: this, });
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

  setInitialView(storedHash, { rotation, sidebarView,
                               scrollMode, spreadMode, } = {}) {
    let setRotation = (angle) => {
      if (isValidRotation(angle)) {
        this.pdfViewer.pagesRotation = angle;
      }
    };
    let setViewerModes = (scroll, spread) => {
      if (Number.isInteger(scroll)) {
        this.pdfViewer.scrollMode = scroll;
      }
      if (Number.isInteger(spread)) {
        this.pdfViewer.spreadMode = spread;
      }
    };

    // Putting these before isInitialViewSet = true prevents these values from
    // being stored in the document history (and overriding any future changes
    // made to the corresponding global preferences), just this once.
    setViewerModes(scrollMode, spreadMode);

    this.isInitialViewSet = true;

    if (this.initialBookmark) {
      setRotation(this.initialRotation);
      delete this.initialRotation;

      this.pdfLinkService.setHash(this.initialBookmark);
      this.initialBookmark = null;
    } else if (storedHash) {
      setRotation(rotation);

      this.pdfLinkService.setHash(storedHash);
    }

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
  },

  forceRendering() {
  },

  beforePrint() {
    

    
    
  },

  afterPrint: function pdfViewSetupAfterPrint() {
    
  },

  rotatePages(delta) {
    if (!this.pdfDocument) {
      return;
    }
    let newRotation = (this.pdfViewer.pagesRotation + 360 + delta) % 360;
    this.pdfViewer.pagesRotation = newRotation;
    // Note that the thumbnail viewer is updated, and rendering is triggered,
    // in the 'rotationchanging' event handler.
  },

  requestPresentationMode() {
    if (!this.pdfPresentationMode) {
      return;
    }
    this.pdfPresentationMode.request();
  }
};

let validateFileURL;
if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
  const HOSTED_VIEWER_ORIGINS = ['null',
    'http://mozilla.github.io', 'https://mozilla.github.io'];
  validateFileURL = function validateFileURL(file) {
    if (file === undefined) {
      return;
    }
    try {
      let viewerOrigin = new URL(window.location.href).origin || 'null';
      if (HOSTED_VIEWER_ORIGINS.includes(viewerOrigin)) {
        // Hosted or local viewer, allow for any file locations
        return;
      }
      let { origin, protocol, } = new URL(file, window.location.href);
      // Removing of the following line will not guarantee that the viewer will
      // start accepting URLs from foreign origin -- CORS headers on the remote
      // server must be properly configured.
      // IE10 / IE11 does not include an origin in `blob:`-URLs. So don't block
      // any blob:-URL. The browser's same-origin policy will block requests to
      // blob:-URLs from other origins, so this is safe.
      if (origin !== viewerOrigin && protocol !== 'blob:') {
        throw new Error('file origin does not match viewer\'s');
      }
    } catch (ex) {
      let message = ex && ex.message;
      PDFViewerApplication.l10n.get('loading_error', null,
          'An error occurred while loading the PDF.').
          then((loadingErrorMessage) => {
        PDFViewerApplication.error(loadingErrorMessage, { message, });
      });
      throw ex;
    }
  };
}

function loadFakeWorker() {
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = AppOptions.get('workerSrc');
  }
  if (typeof PDFJSDev === 'undefined' || !PDFJSDev.test('PRODUCTION')) {
    return new Promise(function(resolve, reject) {
      if (typeof SystemJS === 'object') {
        SystemJS.import('pdfjs/core/worker').then((worker) => {
          window.pdfjsWorker = worker;
          resolve();
        }).catch(reject);
      } else if (typeof require === 'function') {
        try {
          window.pdfjsWorker = require('../src/core/worker.js');
          resolve();
        } catch (ex) {
          reject(ex);
        }
      } else {
        reject(new Error(
          'SystemJS or CommonJS must be used to load fake worker.'));
      }
    });
  }
  return loadScript(PDFWorker.getWorkerSrc());
}

function loadAndEnablePDFBug(enabledTabs) {
  let appConfig = PDFViewerApplication.appConfig;
  return loadScript(appConfig.debuggerScriptPath).then(function() {
    PDFBug.enable(enabledTabs);
    PDFBug.init({
      OPS,
      createObjectURL,
    }, appConfig.mainContainer);
  });
}

function webViewerInitialized() {
  let appConfig = PDFViewerApplication.appConfig;
  let file;
  if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
    let queryString = document.location.search.substring(1);
    let params = parseQueryString(queryString);
    file = 'file' in params ? params.file : AppOptions.get('defaultUrl');
    validateFileURL(file);
  } else if (PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
    file = window.location.href.split('#')[0];
  } else if (PDFJSDev.test('CHROME')) {
    file = AppOptions.get('defaultUrl');
  }

  if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
    let fileInput = document.createElement('input');
    fileInput.id = appConfig.openFileInputName;
    fileInput.className = 'fileInput';
    fileInput.setAttribute('type', 'file');
    document.body.appendChild(fileInput);

    if (!window.File || !window.FileReader ||
        !window.FileList || !window.Blob) {
    } else {
      fileInput.value = null;
    }

    fileInput.addEventListener('change', function(evt) {
      let files = evt.target.files;
      if (!files || files.length === 0) {
        return;
      }
      PDFViewerApplication.eventBus.dispatch('fileinputchange', {
        source: this,
        fileInput: evt.target,
      });
    });

    // Enable draging-and-dropping a new PDF file onto the viewerContainer.
    appConfig.mainContainer.addEventListener('dragover', function(evt) {
      evt.preventDefault();

      evt.dataTransfer.dropEffect = 'move';
    });
    appConfig.mainContainer.addEventListener('drop', function(evt) {
      evt.preventDefault();

      const files = evt.dataTransfer.files;
      if (!files || files.length === 0) {
        return;
      }
      PDFViewerApplication.eventBus.dispatch('fileinputchange', {
        source: this,
        fileInput: evt.dataTransfer,
      });
    });
  } 

  if (typeof PDFJSDev !== 'undefined' &&
      PDFJSDev.test('FIREFOX || MOZCENTRAL') &&
      !PDFViewerApplication.supportsDocumentFonts) {
    AppOptions.set('disableFontFace', true);
    PDFViewerApplication.l10n.get('web_fonts_disabled', null,
      'Web fonts are disabled: unable to use embedded PDF fonts.').
        then((msg) => {
      console.warn(msg);
    });
  }


  appConfig.mainContainer.addEventListener('transitionend', function(evt) {
    if (evt.target === /* mainContainer */ this) {
      PDFViewerApplication.eventBus.dispatch('resize', { source: this, });
    }
  }, true);


  try {
    webViewerOpenFileViaURL(file);
  } catch (reason) {
    PDFViewerApplication.l10n.get('loading_error', null,
        'An error occurred while loading the PDF.').then((msg) => {
      PDFViewerApplication.error(msg, reason);
    });
  }
}

let webViewerOpenFileViaURL;
if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
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
} else if (PDFJSDev.test('FIREFOX || MOZCENTRAL || CHROME')) {
  webViewerOpenFileViaURL = function webViewerOpenFileViaURL(file) {
    PDFViewerApplication.setTitleUsingUrl(file);
    PDFViewerApplication.initPassiveLoading();
  };
} else {
  webViewerOpenFileViaURL = function webViewerOpenFileViaURL(file) {
    if (file) {
      throw new Error('Not implemented: webViewerOpenFileViaURL');
    }
  };
}

function webViewerPageRendered(evt) {
  let pageNumber = evt.pageNumber;
  let pageIndex = pageNumber - 1;
  let pageView = PDFViewerApplication.pdfViewer.getPageView(pageIndex);

  // Prevent errors in the edge-case where the PDF document is removed *before*
  // the 'pagerendered' event handler is invoked.
  if (!pageView) {
    return;
  }


  if (typeof Stats !== 'undefined' && Stats.enabled && pageView.stats) {
    Stats.add(pageNumber, pageView.stats);
  }

  if (pageView.error) {
    PDFViewerApplication.l10n.get('rendering_error', null,
        'An error occurred while rendering the page.').then((msg) => {
      PDFViewerApplication.error(msg, pageView.error);
    });
  }

  if (typeof PDFJSDev !== 'undefined' &&
      PDFJSDev.test('FIREFOX || MOZCENTRAL')) {
    PDFViewerApplication.externalServices.reportTelemetry({
      type: 'pageInfo',
    });
    // It is a good time to report stream and font types.
    PDFViewerApplication.pdfDocument.getStats().then(function (stats) {
      PDFViewerApplication.externalServices.reportTelemetry({
        type: 'documentStats',
        stats,
      });
    });
  }
}

function webViewerTextLayerRendered(evt) {
  if (typeof PDFJSDev !== 'undefined' &&
      PDFJSDev.test('FIREFOX || MOZCENTRAL') &&
      evt.numTextDivs > 0 && !PDFViewerApplication.supportsDocumentColors) {
    PDFViewerApplication.l10n.get('document_colors_not_allowed', null,
      'PDF documents are not allowed to use their own colors: ' +
      '\'Allow pages to choose their own colors\' ' +
      'is deactivated in the browser.').
        then((msg) => {
      console.error(msg);
    });
    PDFViewerApplication.fallback();
  }
}

function webViewerPageMode(evt) {
  // Handle the 'pagemode' hash parameter, see also `PDFLinkService_setHash`.
  let mode = evt.mode, view;
  switch (mode) {
    case 'thumbs':
      view = SidebarView.THUMBS;
      break;
    case 'bookmarks':
    case 'outline':
      view = SidebarView.OUTLINE;
      break;
    case 'attachments':
      view = SidebarView.ATTACHMENTS;
      break;
    case 'none':
      view = SidebarView.NONE;
      break;
    default:
      console.error('Invalid "pagemode" hash parameter: ' + mode);
      return;
  }
}

function webViewerNamedAction(evt) {
  // Processing couple of named actions that might be useful.
  // See also PDFLinkService.executeNamedAction
  let action = evt.action;
  switch (action) {
    case 'GoToPage':
      break;

    case 'Find':
      if (!PDFViewerApplication.supportsIntegratedFind) {
        PDFViewerApplication.findBar.toggle();
      }
      break;
  }
}

function webViewerPresentationModeChanged(evt) {
  let { active, switchInProgress, } = evt;
  PDFViewerApplication.pdfViewer.presentationModeState =
    switchInProgress ? PresentationModeState.CHANGING :
    active ? PresentationModeState.FULLSCREEN : PresentationModeState.NORMAL;
}

function webViewerSidebarViewChanged(evt) {

  let store = PDFViewerApplication.store;
  if (store && PDFViewerApplication.isInitialViewSet) {
    // Only update the storage when the document has been loaded *and* rendered.
    store.set('sidebarView', evt.view).catch(function() { });
  }
}

function webViewerUpdateViewarea(evt) {
  let location = evt.location, store = PDFViewerApplication.store;

}

function webViewerScrollModeChanged(evt) {
  let store = PDFViewerApplication.store;
  if (store && PDFViewerApplication.isInitialViewSet) {
    // Only update the storage when the document has been loaded *and* rendered.
    store.set('scrollMode', evt.mode).catch(function() { });
  }
}

function webViewerSpreadModeChanged(evt) {
  let store = PDFViewerApplication.store;
  if (store && PDFViewerApplication.isInitialViewSet) {
    // Only update the storage when the document has been loaded *and* rendered.
    store.set('spreadMode', evt.mode).catch(function() { });
  }
}

function webViewerResize() {
  let { pdfDocument, pdfViewer, } = PDFViewerApplication;
  if (!pdfDocument) {
    return;
  }
  let currentScaleValue = pdfViewer.currentScaleValue;
  if (currentScaleValue === 'auto' ||
      currentScaleValue === 'page-fit' ||
      currentScaleValue === 'page-width') {
    // Note: the scale is constant for 'page-actual'.
    pdfViewer.currentScaleValue = currentScaleValue;
  }
  pdfViewer.update();
}

function webViewerHashchange(evt) {
  let hash = evt.hash;
  if (!hash) {
    return;
  }
  if (!PDFViewerApplication.isInitialViewSet) {
    PDFViewerApplication.initialBookmark = hash;
  } else if (!PDFViewerApplication.pdfHistory.popStateInProgress) {
    PDFViewerApplication.pdfLinkService.setHash(hash);
  }
}

let webViewerFileInputChange;
if (typeof PDFJSDev === 'undefined' || PDFJSDev.test('GENERIC')) {
  webViewerFileInputChange = function webViewerFileInputChange(evt) {
    if (PDFViewerApplication.pdfViewer &&
        PDFViewerApplication.pdfViewer.isInPresentationMode) {
      return; // Opening a new PDF file isn't supported in Presentation Mode.
    }
    let file = evt.fileInput.files[0];

    if (URL.createObjectURL && !AppOptions.get('disableCreateObjectURL')) {
      let url = URL.createObjectURL(file);
      if (file.name) {
        url = { url, originalUrl: file.name, };
      }
      PDFViewerApplication.open(url);
    } else {
      PDFViewerApplication.setTitleUsingUrl(file.name);
      // Read the local file into a Uint8Array.
      let fileReader = new FileReader();
      fileReader.onload = function webViewerChangeFileReaderOnload(evt) {
        let buffer = evt.target.result;
        PDFViewerApplication.open(new Uint8Array(buffer));
      };
      fileReader.readAsArrayBuffer(file);
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
