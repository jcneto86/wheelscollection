/**
 * Alpine controller for Wheels Collection.
 *
 * This is the object behind `<body x-data="app">`. It owns the state of the
 * SPA (session, routes, collection, form, cropper, OCR panel, preferences) and
 * delegates the heavy lifting to the modules:
 *
 *   app.js          OCR engine + `attachOcrPanel()` adapter
 *   image-crop.js   CropSession (500x500 export + high-resolution OCR canvas)
 *   firebase.js     Auth and Firestore (loaded lazily, only after start)
 *   router.js       hash router
 *   i18n.js         dictionaries and `translate()`
 *   preferences.js  theme, palette, locale and OCR preference
 *
 * Everything is wired in `init()`, which Alpine calls once the DOM is ready.
 */

import { attachOcrPanel, terminateOcr, preloadOcr, isMeteredConnection } from './app.js';
import { CropSession } from './image-crop.js';
import { LIMITS, isFirebaseConfigured } from './firebase-config.js';
import { LOCALES, initI18n, translate } from './i18n.js';
import {
  PALETTES,
  STORAGE_KEYS,
  THEME_MODES,
  applyPalette,
  applyTheme,
  getSystemDark,
  isDarkMode,
  loadPreferences,
  savePreference,
} from './preferences.js';
import { createRouter } from './router.js';

const ALPINE_URL =
  'https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/module.esm.js';

const CROP_VIEW_SIZE = 400;
const TOAST_DURATION = 4200;

/* -------------------------------------------------------------------------- */
/* Module scope (never proxied by Alpine)                                     */
/* -------------------------------------------------------------------------- */

let started = false;
let firebase = null;
let router = null;
let cropSession = null;
let dragState = null;
let toastTimer = 0;
let unsubscribeAuth = null;
let unsubscribeItems = null;
let mediaQuery = null;
let mediaListener = null;
let intendedPath = null;

/** Resolves after the first collection snapshot (or on error). */
let itemsReady = Promise.resolve();
let resolveItems = null;

/** Resolves when the authentication state is known. */
let resolveAuthGate = null;
const authGate = new Promise((resolve) => {
  resolveAuthGate = resolve;
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lowercase, accent-insensitive text used by the search box. */
function normalizeTerm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function capitalize(value) {
  const text = String(value || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function disposeCropSession() {
  if (!cropSession) return;
  try {
    cropSession.dispose();
  } catch (error) {
    console.warn('[crop] could not dispose the session:', error);
  }
  cropSession = null;
  dragState = null;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function createApp() {
  const hasWindow = typeof window !== 'undefined';
  const preferences = hasWindow
    ? loadPreferences()
    : { themeMode: 'system', palette: 'crimson', locale: 'en-CA' };

  return {
    /* ------------------------------------------------------------------ */
    /* State                                                              */
    /* ------------------------------------------------------------------ */

    firebaseMissing: !isFirebaseConfigured(),
    authReady: false,
    authLoading: false,
    authMode: 'login',
    authForm: { name: '', email: '', password: '' },
    authErrors: {},
    authError: '',
    authInfo: '',
    showPassword: false,

    user: null,
    items: [],
    itemsLoading: true,
    itemsError: '',
    search: '',

    route: { name: 'home', path: '/', params: {} },

    locale: preferences.locale,
    locales: LOCALES,
    themeMode: preferences.themeMode,
    palette: preferences.palette,
    palettes: PALETTES,

    toast: { open: false, message: '', type: 'success' },
    accountMenuOpen: false,
    deleteOpen: false,
    deleting: false,
    deleteTarget: null,

    form: { id: null, name: '', description: '', imageBase64: '' },
    formMode: 'new',
    formLoading: false,
    formSaving: false,
    formErrors: {},
    formError: '',
    formNotFound: false,

    cropper: { open: false, loading: false, zoom: 1, minZoom: 1, error: '' },
    ocr: {
      open: false,
      scanning: false,
      auto: false,
      progress: 0,
      stage: 'library',
      result: null,
      error: '',
      autoEnabled: true,
    },

    limits: LIMITS,

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                          */
    /* ------------------------------------------------------------------ */

    async init() {
      if (started) return;
      started = true;

      applyTheme(this.themeMode);
      applyPalette(this.palette);
      if (hasWindow) document.documentElement.lang = this.locale;

      attachOcrPanel(this);

      router = createRouter((next) => this.handleRoute(next));

      if (hasWindow && typeof window.matchMedia === 'function') {
        mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaListener = () => {
          if (this.themeMode === 'system') {
            applyTheme('system');
            this.themeMode = 'system';
          }
        };
        mediaQuery.addEventListener?.('change', mediaListener);
      }

      if (this.firebaseMissing) {
        this.finishBootstrap();
        return;
      }

      try {
        firebase = await import('./firebase.js');
      } catch (error) {
        console.error('[app] Firebase could not be loaded:', error);
        this.authError = this.t('errorNetworkRequestFailed');
        this.finishBootstrap();
        return;
      }

      unsubscribeAuth = firebase.observeAuth((user) => {
        const previous = this.user;
        this.user = user;

        if (user) {
          this.startItems(user);
        } else {
          this.stopItems();
          this.items = [];
          this.itemsLoading = false;
          if (previous) this.resetForm();
        }

        this.finishBootstrap();
        if (router) this.handleRoute(router.current);
      });
    },

    destroy() {
      if (unsubscribeAuth) unsubscribeAuth();
      if (unsubscribeItems) unsubscribeItems();
      unsubscribeAuth = null;
      unsubscribeItems = null;

      if (mediaQuery && mediaListener) {
        mediaQuery.removeEventListener?.('change', mediaListener);
      }

      disposeCropSession();
      this.ocrCleanup?.();
      void terminateOcr();
      started = false;
    },

    /** Marks the app as ready and releases whoever is waiting for auth. */
    finishBootstrap() {
      if (!this.authReady) this.authReady = true;
      if (resolveAuthGate) {
        resolveAuthGate();
        resolveAuthGate = null;
      }
    },

    /* ------------------------------------------------------------------ */
    /* Routing                                                            */
    /* ------------------------------------------------------------------ */

    handleRoute(next) {
      if (!next) return;

      this.route = {
        name: next.name,
        path: next.path,
        params: next.params || {},
      };
      this.accountMenuOpen = false;
      this.deleteOpen = false;

      if (!this.authReady || this.firebaseMissing) return;

      if (!this.user && next.name !== 'login') {
        intendedPath = next.path;
        router.navigate('/login', { replace: true });
        return;
      }

      if (this.user && next.name === 'login') {
        const target = intendedPath && intendedPath !== '/login' ? intendedPath : '/';
        intendedPath = null;
        router.navigate(target, { replace: true });
        return;
      }

      if (next.name === 'form') {
        if (next.params?.id) this.loadItemForForm(next.params.id);
        else this.resetForm();
      }
    },

    link(path) {
      return router ? router.link(path) : `#${path}`;
    },

    /* ------------------------------------------------------------------ */
    /* Authentication                                                     */
    /* ------------------------------------------------------------------ */

    switchAuthMode(mode) {
      if (!['login', 'register', 'forgot'].includes(mode)) return;
      this.authMode = mode;
      this.authErrors = {};
      this.authError = '';
      this.authInfo = '';
      this.showPassword = false;
    },

    authTitle() {
      if (this.authMode === 'register') return this.t('createAccountTitle');
      if (this.authMode === 'forgot') return this.t('forgotPasswordTitle');
      return this.t('welcomeBack');
    },

    authSubtitle() {
      if (this.authMode === 'register') return this.t('createAccountSubtitle');
      if (this.authMode === 'forgot') return this.t('forgotPasswordSubtitle');
      return this.t('welcomeBackSubtitle');
    },

    validateAuth() {
      const errors = {};
      const email = String(this.authForm.email || '').trim();
      const password = String(this.authForm.password || '');

      if (this.authMode === 'register' && !String(this.authForm.name || '').trim()) {
        errors.name = this.t('validatorNameRequired');
      }

      if (!email) errors.email = this.t('validatorEmailRequired');
      else if (!EMAIL_PATTERN.test(email)) errors.email = this.t('validatorEmailInvalid');

      if (this.authMode !== 'forgot') {
        if (!password) errors.password = this.t('validatorPasswordRequired');
        else if (password.length < LIMITS.minPassword) {
          errors.password = this.t('validatorPasswordMinLength', { min: LIMITS.minPassword });
        }
      }

      return errors;
    },

    async submitAuth() {
      if (this.authLoading) return;

      this.authError = '';
      this.authInfo = '';

      const errors = this.validateAuth();
      this.authErrors = errors;
      if (Object.keys(errors).length) return;

      if (!firebase) {
        this.authError = this.t('errorFirebaseNotConfigured');
        return;
      }

      this.authLoading = true;
      const email = String(this.authForm.email || '').trim();
      const password = String(this.authForm.password || '');

      try {
        if (this.authMode === 'forgot') {
          await firebase.sendResetEmail(email);
          this.authInfo = this.t('resetEmailSent');
        } else if (this.authMode === 'register') {
          await firebase.registerUser(this.authForm.name, email, password);
        } else {
          await firebase.signInUser(email, password);
        }

        this.authForm.password = '';
        this.authErrors = {};
      } catch (error) {
        console.error('[auth]', error);
        this.authError = this.describeAuthError(error);
      } finally {
        this.authLoading = false;
      }
    },

    async logout() {
      if (!firebase) return;
      try {
        await firebase.signOutUser();
        this.showToast(this.t('signedOut'));
      } catch (error) {
        console.error('[auth] sign out failed:', error);
        this.showToast(this.describeAuthError(error), 'error');
      }
    },

    describeAuthError(error) {
      const code = String(error?.code || '');

      switch (code) {
        case 'auth/invalid-email':
          return this.t('errorInvalidEmail');
        case 'auth/user-disabled':
          return this.t('errorUserDisabled');
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
          return this.t('errorInvalidCredentials');
        case 'auth/email-already-in-use':
          return this.t('errorEmailAlreadyInUse');
        case 'auth/weak-password':
          return this.t('errorWeakPassword');
        case 'auth/too-many-requests':
          return this.t('errorTooManyRequests');
        case 'auth/network-request-failed':
          return this.t('errorNetworkRequestFailed');
        case 'auth/operation-not-allowed':
          return this.t('errorOperationNotAllowed');
        case 'auth/requires-recent-login':
          return this.t('errorRequiresRecentLogin');
        case 'firebase/not-configured':
          return this.t('errorFirebaseNotConfigured');
        default:
          return this.authMode === 'register'
            ? this.t('errorSignUpFailed')
            : this.t('errorAuthUnknown');
      }
    },

    /* ------------------------------------------------------------------ */
    /* Account display                                                    */
    /* ------------------------------------------------------------------ */

    userDisplayName() {
      const user = this.user;
      if (!user) return this.t('sessionUnidentified');

      const name = String(user.displayName || '').trim();
      if (name) return name;

      const email = String(user.email || '').trim();
      return email ? email.split('@')[0] : this.t('sessionUnidentified');
    },

    userEmail() {
      return String(this.user?.email || '').trim();
    },

    userInitial() {
      const source = this.userDisplayName();
      const letter = source.trim().charAt(0);
      return letter ? letter.toUpperCase() : '?';
    },

    toggleAccountMenu() {
      this.accountMenuOpen = !this.accountMenuOpen;
    },

    /* ------------------------------------------------------------------ */
    /* Collection                                                         */
    /* ------------------------------------------------------------------ */

    startItems(user) {
      if (!firebase || !user) return;

      this.itemsLoading = true;
      this.itemsError = '';

      itemsReady = new Promise((resolve) => {
        resolveItems = resolve;
      });

      const release = () => {
        if (resolveItems) {
          resolveItems();
          resolveItems = null;
        }
      };

      if (unsubscribeItems) {
        unsubscribeItems();
        unsubscribeItems = null;
      }

      unsubscribeItems = firebase.subscribeToItems(
        user.uid,
        (items) => {
          this.items = items;
          this.itemsLoading = false;
          this.itemsError = '';
          release();
          this.resolvePendingForm();
        },
        (error) => {
          console.error('[collection]', error);
          this.itemsLoading = false;
          this.itemsError = this.describeFirestoreError(error);
          release();
        },
      );
    },

    stopItems() {
      if (unsubscribeItems) {
        unsubscribeItems();
        unsubscribeItems = null;
      }
      if (resolveItems) {
        resolveItems();
        resolveItems = null;
      }
    },

    retryItems() {
      if (!this.user) return;
      this.startItems(this.user);
    },

    hasItems() {
      return this.items.length > 0;
    },

    hasSearch() {
      return String(this.search || '').trim().length > 0;
    },

    clearSearch() {
      this.search = '';
    },

    filteredItems() {
      const term = normalizeTerm(this.search);
      if (!term) return this.items;

      return this.items.filter(
        (item) =>
          normalizeTerm(item.name).includes(term) ||
          normalizeTerm(item.description).includes(term),
      );
    },

    garageSummary() {
      const count = this.items.length;
      if (count === 0) return this.t('carsInGarageZero');
      if (count === 1) return this.t('carsInGarageOne');
      return this.t('carsInGarageOther', { count });
    },

    detailItem() {
      if (this.route.name !== 'details') return null;
      const id = this.route.params?.id;
      return this.items.find((item) => item.id === id) || null;
    },

    carPhotoAlt(name) {
      return this.t('carPhotoAlt', { name: String(name || '') });
    },

    imageSrc(imageBase64) {
      const base64 = String(imageBase64 || '');
      return base64 ? `data:image/jpeg;base64,${base64}` : '';
    },

    formatDate(value) {
      if (!value) return '';
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';

      try {
        return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium' }).format(date);
      } catch {
        return date.toISOString().slice(0, 10);
      }
    },

    currentYear() {
      return new Date().getFullYear();
    },

    /* ------------------------------------------------------------------ */
    /* Delete                                                             */
    /* ------------------------------------------------------------------ */

    requestDelete() {
      const target = this.detailItem();
      if (!target) return;
      this.deleteTarget = target;
      this.deleteOpen = true;
    },

    deleteMessage() {
      const name = this.deleteTarget?.name || this.detailItem()?.name || '';
      return this.t('deleteCarMessage', { name });
    },

    async confirmDelete() {
      const target = this.deleteTarget;
      if (!target || this.deleting) return;

      if (!firebase) {
        this.showToast(this.t('errorFirebaseNotConfigured'), 'error');
        return;
      }

      this.deleting = true;
      try {
        await firebase.deleteItem(target.id);
        this.deleteOpen = false;
        this.deleteTarget = null;
        this.showToast(this.t('carDeleted'));
        if (this.route.name === 'details' || this.route.name === 'form') {
          router.navigate('/');
        }
      } catch (error) {
        console.error('[delete]', error);
        this.showToast(this.describeFirestoreError(error), 'error');
      } finally {
        this.deleting = false;
      }
    },

    /* ------------------------------------------------------------------ */
    /* Form                                                               */
    /* ------------------------------------------------------------------ */

    formTitle() {
      return this.formMode === 'edit' ? this.t('editCar') : this.t('newCar');
    },

    formSubtitle() {
      return this.formMode === 'edit' ? this.t('editCarSubtitle') : this.t('newCarSubtitle');
    },

    resetForm() {
      this.formMode = 'new';
      this.form.id = null;
      this.form.name = '';
      this.form.description = '';
      this.form.imageBase64 = '';
      this.formErrors = {};
      this.formError = '';
      this.formLoading = false;
      this.formNotFound = false;
      this.ocrCleanup?.();
      this.ocr.result = null;
      this.ocr.error = '';
    },

    async loadItemForForm(id) {
      this.formMode = 'edit';
      this.form.id = id;
      this.formNotFound = false;
      this.formLoading = true;
      this.formError = '';
      this.formErrors = {};

      await authGate;
      await itemsReady;

      if (this.route.name !== 'form' || this.route.params?.id !== id) return;

      const item = this.items.find((entry) => entry.id === id);

      if (!item) {
        this.formNotFound = true;
        this.formLoading = false;
        return;
      }

      this.fillForm(item);
    },

    /** Fills the form from a snapshot item (also used by the subscription). */
    fillForm(item) {
      if (!item) return;
      this.formMode = 'edit';
      this.form.id = item.id;
      this.form.name = item.name;
      this.form.description = item.description;
      this.form.imageBase64 = item.imageBase64;
      this.formLoading = false;
      this.formNotFound = false;
    },

    /** Called when the collection snapshot arrives for a pending edit route. */
    resolvePendingForm() {
      if (this.route.name !== 'form') return;
      const id = this.route.params?.id;
      if (!id || !this.formLoading) return;

      const item = this.items.find((entry) => entry.id === id);
      if (item) this.fillForm(item);
      else {
        this.formNotFound = true;
        this.formLoading = false;
      }
    },

    validateForm() {
      const errors = {};
      const name = String(this.form.name || '').trim();
      const description = String(this.form.description || '').trim();

      if (!name) errors.name = this.t('validatorCarNameRequired');
      else if (name.length > LIMITS.name) {
        errors.name = this.t('validatorCarNameMaxLength', { max: LIMITS.name });
      }

      if (!description) errors.description = this.t('validatorDescriptionRequired');
      else if (description.length > LIMITS.description) {
        errors.description = this.t('validatorDescriptionMaxLength', {
          max: LIMITS.description,
        });
      }

      if (!this.form.imageBase64) errors.image = this.t('errorCarPhotoRequired');

      return errors;
    },

    async submitForm() {
      if (this.formSaving) return;

      this.formError = '';
      const errors = this.validateForm();
      this.formErrors = errors;
      if (Object.keys(errors).length) return;

      if (!firebase) {
        this.formError = this.t('errorFirebaseNotConfigured');
        return;
      }

      if (!this.user) {
        this.formError = this.t('sessionExpired');
        return;
      }

      this.formSaving = true;

      try {
        const payload = {
          name: String(this.form.name || '').trim(),
          description: String(this.form.description || '').trim(),
          imageBase64: this.form.imageBase64,
        };

        if (this.formMode === 'edit' && this.form.id) {
          await firebase.updateItem(this.form.id, payload);
          this.showToast(this.t('carUpdated'));
        } else {
          await firebase.createItem({ userId: this.user.uid, ...payload });
          this.showToast(this.t('carAdded'));
        }

        this.ocrCleanup?.();
        router.navigate('/');
      } catch (error) {
        console.error('[form] save failed:', error);
        this.formError = this.describeFirestoreError(error);
      } finally {
        this.formSaving = false;
      }
    },

    cancelForm() {
      this.ocrCleanup?.();
      router.navigate('/');
    },

    describeFirestoreError(error) {
      const code = String(error?.code || '').replace(/^firestore\//, '');

      switch (code) {
        case 'permission-denied':
          return this.t('errorPermissionDenied');
        case 'unavailable':
          return this.t('errorUnavailable');
        case 'not-found':
          return this.t('errorNotFound');
        case 'resource-exhausted':
          return this.t('errorQuotaExceeded');
        case 'invalid-argument':
          return this.t('errorInvalidArgument');
        case 'unauthenticated':
          return this.t('sessionExpired');
        case 'deadline-exceeded':
          return this.t('errorNetworkRequestFailed');
        case 'firebase/not-configured':
          return this.t('errorFirebaseNotConfigured');
        default:
          return this.t('errorUnknown');
      }
    },

    /* ------------------------------------------------------------------ */
    /* Image / cropper                                                    */
    /* ------------------------------------------------------------------ */

    openFilePicker(kind) {
      const input =
        kind === 'camera' ? this.$refs.cameraInput : this.$refs.galleryInput;
      if (!input) return;
      input.value = '';
      input.click();
    },

    async onFileSelected(event) {
      const input = event?.target;
      const file = input?.files?.[0];
      if (input) input.value = '';
      if (!file) return;

      if (!/^image\//i.test(file.type)) {
        this.showToast(this.t('errorImageFileType'), 'error');
        return;
      }

      if (file.size > LIMITS.maxSourceFileBytes) {
        this.showToast(this.t('errorImageFileSize'), 'error');
        return;
      }

      // Warm up the neural OCR while the user adjusts the crop. Skipped on
      // metered connections because it downloads the models (~15 MB).
      if (!isMeteredConnection()) void preloadOcr();

      this.cropper.open = true;
      this.cropper.loading = true;
      this.cropper.error = '';
      disposeCropSession();

      try {
        await this.$nextTick();
        const canvas = this.$refs.cropCanvas;
        if (!canvas) throw new Error('crop-canvas-unavailable');

        cropSession = await CropSession.fromFile(file, canvas, CROP_VIEW_SIZE);
        this.syncCropState();
      } catch (error) {
        console.error('[crop] open failed:', error);
        this.cropper.open = false;
        this.showToast(
          this.t(error?.message === 'crop-canvas-unavailable' ? 'errorCropFailed' : 'cropError'),
          'error',
        );
      } finally {
        this.cropper.loading = false;
      }
    },

    syncCropState() {
      if (!cropSession) return;
      this.cropper.zoom = cropSession.zoom;
      this.cropper.minZoom = cropSession.minZoom;
    },

    updateCropZoom(value) {
      if (!cropSession) return;
      cropSession.setZoom(Number(value));
      this.syncCropState();
    },

    rotateCrop(delta) {
      if (!cropSession) return;
      cropSession.rotate(Number(delta) || 0);
      this.syncCropState();
    },

    resetCrop() {
      if (!cropSession) return;
      cropSession.reset();
      this.syncCropState();
    },

    cropPointerDown(event) {
      if (!cropSession || this.cropper.loading) return;

      const canvas = this.$refs.cropCanvas;
      const rect = canvas?.getBoundingClientRect?.();
      const ratio = rect && rect.width > 0 ? cropSession.view / rect.width : 1;

      dragState = {
        x: event.clientX,
        y: event.clientY,
        ratio,
      };

      event.currentTarget?.setPointerCapture?.(event.pointerId);
    },

    cropPointerMove(event) {
      if (!dragState || !cropSession) return;

      const dx = (event.clientX - dragState.x) * dragState.ratio;
      const dy = (event.clientY - dragState.y) * dragState.ratio;

      dragState.x = event.clientX;
      dragState.y = event.clientY;

      cropSession.panBy(dx, dy);
    },

    cropPointerUp() {
      dragState = null;
    },

    cropWheel(event) {
      if (!cropSession) return;
      const step = Number(event.deltaY) > 0 ? -0.05 : 0.05;
      cropSession.setZoom(cropSession.zoom + step);
      this.syncCropState();
    },

    cancelCrop() {
      disposeCropSession();
      this.cropper.open = false;
      this.cropper.loading = false;
      this.cropper.error = '';
      this.syncCropState();
      this.ocrCleanup?.();
    },

    applyCrop() {
      if (!cropSession) {
        this.cancelCrop();
        return;
      }

      try {
        /* Same framing, higher resolution: the OCR canvas is disposable and
         * never persisted. The stored image stays 500x500 JPEG. */
        const ocrCanvas = cropSession.toOcrCanvas();
        const base64 = cropSession.toBase64();

        disposeCropSession();
        this.cropper.open = false;
        this.cropper.error = '';
        this.syncCropState();

        this.form.imageBase64 = base64;
        delete this.formErrors.image;
        this.ocrOnCropApplied?.(ocrCanvas);
      } catch (error) {
        console.error('[crop] apply failed:', error);
        this.cropper.error = this.t(
          error?.message === 'image-too-large' ? 'errorImageTooLarge' : 'errorCropFailed',
        );
      }
    },

    removeImage() {
      this.form.imageBase64 = '';
      delete this.formErrors.image;
      this.ocrCleanup?.();
      this.ocr.result = null;
      this.ocr.error = '';
    },

    /* ------------------------------------------------------------------ */
    /* OCR panel                                                          */
    /* ------------------------------------------------------------------ */

    /** Maps the scan stage to its translated label. */
    ocrStageLabel() {
      const stages = [
        'library',
        'preparing',
        'analyzing',
        'full',
        'bottom',
        'side',
        'numbers',
        'parsing',
      ];
      const stage = stages.includes(this.ocr.stage) ? this.ocr.stage : 'library';
      return this.t(`ocrStatus${capitalize(stage)}`);
    },

    /** Short status shown in the collapsed accordion header. */
    ocrStatusSummary() {
      if (this.ocr.scanning) {
        return this.ocr.auto ? this.t('ocrAutoReading') : this.ocrStageLabel();
      }
      if (this.ocr.error) return this.t('ocrStatusError');
      if (this.ocr.result) return this.t('ocrStatusDone');
      return this.t('ocrStatusIdle');
    },

    /** Colour of the status line (idle/running/success/error). */
    ocrStatusClass() {
      if (this.ocr.scanning) return 'text-brand-700 dark:text-brand-300';
      if (this.ocr.error) return 'text-red-600 dark:text-red-400';
      if (this.ocr.result) return 'text-emerald-600 dark:text-emerald-400';
      return 'text-slate-500 dark:text-slate-400';
    },

    /* ------------------------------------------------------------------ */
    /* Preferences                                                        */
    /* ------------------------------------------------------------------ */

    isDark() {
      return isDarkMode(this.themeMode, getSystemDark());
    },

    setThemeMode(mode) {
      if (!THEME_MODES.includes(mode)) return;
      this.themeMode = mode;
      savePreference(STORAGE_KEYS.theme, mode);
      if (hasWindow) applyTheme(mode);
    },

    toggleTheme() {
      this.setThemeMode(this.isDark() ? 'light' : 'dark');
    },

    setPalette(id) {
      if (!PALETTES.some((entry) => entry.id === id)) return;
      this.palette = id;
      savePreference(STORAGE_KEYS.palette, id);
      if (hasWindow) applyPalette(id);
    },

    paletteLabel(entry) {
      return entry ? this.t(entry.labelKey) : '';
    },

    setLocale(id) {
      if (!LOCALES.some((entry) => entry.id === id)) return;
      this.locale = id;
      savePreference(STORAGE_KEYS.locale, id);
      if (hasWindow) document.documentElement.lang = id;
    },

    /* ------------------------------------------------------------------ */
    /* Feedback                                                           */
    /* ------------------------------------------------------------------ */

    t(key, params) {
      return translate(this.locale, key, params);
    },

    showToast(message, type = 'success') {
      if (!message) return;

      this.toast = { open: true, message: String(message), type };
      if (hasWindow) {
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
          this.toast.open = false;
        }, TOAST_DURATION);
      }
    },

    hideToast() {
      if (hasWindow) window.clearTimeout(toastTimer);
      this.toast.open = false;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Loads the dictionaries and Alpine, registers the component and starts it.
 *
 * The dictionary load happens before `Alpine.start()` on purpose: `translate()`
 * is not reactive, so keys would stay on screen until the next state change.
 */
async function bootstrap() {
  try {
    await initI18n();
  } catch (error) {
    console.error('[i18n] could not load the dictionaries:', error);
  }

  const { default: Alpine } = await import(ALPINE_URL);

  // The 15s fallback in index.html checks for this global.
  window.Alpine = Alpine;

  Alpine.data('app', createApp);
  Alpine.start();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrap().catch((error) => {
    console.error('[app] startup failed:', error);
  });
}
