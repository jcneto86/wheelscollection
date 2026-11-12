import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApp } from '../../js/controller.js';
import { attachOcrPanel } from '../../js/app.js';
import { loadPreferences } from '../../js/preferences.js';

const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/**
 * The controller is a plain object, so the browser-free half of it can be
 * exercised directly. `t()` falls back to the key when no dictionary is loaded,
 * which makes the assertions readable.
 */
function createComponent(overrides = {}) {
  return { ...createApp(), ...overrides };
}

test('createApp exposes the state the HTML binds to', () => {
  const app = createApp();

  for (const key of [
    'authReady',
    'authMode',
    'authForm',
    'form',
    'formErrors',
    'formMode',
    'cropper',
    'ocr',
    'toast',
    'route',
    'items',
    'collections',
    'collectionsLoading',
    'collectionsError',
    'specialOnly',
    'selectedCollections',
    'collectionFilterOpen',
    'itemsLoadingMore',
    'itemsComplete',
    'itemsSyncMode',
    'itemsTotal',
    'collectionCounts',
    'detailFallback',
    'detailLoading',
    'collectionForm',
    'collectionDelete',
    'limits',
    'locales',
    'palettes',
    'locale',
    'palette',
    'themeMode',
  ]) {
    assert.ok(key in app, `estado ausente: ${key}`);
  }
});

test('every method called from index.html exists on the component', () => {
  const app = createApp();

  attachOcrPanel(app, {
    readAuto: () => true,
    writeAuto: () => {},
    isMetered: () => false,
  });

  /* Globals that legitimately appear inside Alpine expressions. */
  const allowed = new Set(['t', 'encodeURIComponent', 'parseInt', 'parseFloat']);

  const missing = new Set();
  const attributes = /(?:^|\s)(x-[a-z-]+|:[a-zA-Z-]+|@[a-zA-Z.-]+)="([^"]*)"/g;

  for (const attribute of INDEX_HTML.matchAll(attributes)) {
    for (const call of attribute[2].matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      if (name.startsWith('$') || allowed.has(name)) continue;
      if (typeof app[name] !== 'function') missing.add(name);
    }
  }

  assert.deepEqual([...missing], [], `métodos ausentes no controlador: ${[...missing].join(', ')}`);
});

test('every state root used in index.html exists on the component', () => {
  const app = createApp();

  /* Loop variables from x-for and globals available inside the expressions. */
  const allowed = new Set([
    'item', 'entry', 'collection', 'n', 'Math', 'window', 'document', 'navigator',
    'Object', 'JSON', 'Number', 'String', 'Intl', 'URLSearchParams',
  ]);

  const missing = new Set();
  const attributes = /(?:^|\s)(x-[a-z-]+|:[a-zA-Z-]+|@[a-zA-Z.-]+)="([^"]*)"/g;

  for (const attribute of INDEX_HTML.matchAll(attributes)) {
    /* Strip string literals: Tailwind classes live inside :class values. */
    const expression = attribute[2]
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""');

    for (const root of expression.matchAll(/(?<![\w$.])([a-zA-Z_$][\w$]*)\s*\./g)) {
      const name = root[1];
      if (name.startsWith('$') || allowed.has(name)) continue;
      if (!(name in app)) missing.add(name);
    }
  }

  assert.deepEqual([...missing], [], `estado ausente no controlador: ${[...missing].join(', ')}`);
});

test('the documented method list matches the component', () => {
  const app = createApp();

  /* The OCR panel methods are installed by the adapter, exactly as in
   * `init()`; attaching twice must be harmless (WeakMap guard). */
  attachOcrPanel(app, {
    readAuto: () => true,
    writeAuto: () => {},
    isMetered: () => false,
  });
  attachOcrPanel(app, {});

  const methods = [
    't', 'link', 'detailItem', 'isDark', 'setLocale', 'switchAuthMode',
    'cancelCrop', 'toggleTheme', 'userDisplayName', 'userEmail',
    'filteredItems', 'imageSrc', 'openFilePicker', 'setThemeMode',
    'cropPointerUp', 'currentYear', 'userInitial', 'logout', 'clearSearch',
    'retryItems', 'hasItems', 'carPhotoAlt', 'cancelForm', 'onFileSelected',
    'formatDate', 'paletteLabel', 'rotateCrop', 'authTitle', 'authSubtitle',
    'submitAuth', 'toggleAccountMenu', 'garageSummary', 'hasSearch',
    'formTitle', 'formSubtitle', 'submitForm', 'removeImage',
    'scanPackaging', 'ocrStageLabel', 'requestDelete', 'setPalette',
    'deleteMessage', 'confirmDelete', 'cropPointerDown', 'cropPointerMove',
    'cropWheel', 'updateCropZoom', 'resetCrop', 'applyCrop', 'hideToast',
    'showToast', 'cancelOcrScan', 'setOcrAuto', 'ocrOnCropApplied',
    'ocrCleanup', 'init', 'destroy', 'handleRoute',
    'hasFilters', 'clearFilters', 'collectionFor', 'collectionLabel',
    'itemCollectionLabel', 'collectionCarCount', 'collectionCountLabel',
    'collectionFilterLabel', 'isCollectionSelected', 'toggleCollectionFilter',
    'clearCollectionFilter',
    'collectionFormYearMax', 'openCollectionForm', 'closeCollectionForm',
    'validateCollectionForm', 'submitCollectionForm', 'requestDeleteCollection',
    'cancelDeleteCollection', 'deleteCollectionMessage', 'confirmDeleteCollection',
    'startCollections', 'stopCollections', 'retryCollections',
    'startItems', 'stopItems', 'subscribeItems', 'handleItemsSnapshot',
    'itemsNeedMore', 'loadMore', 'syncAllItems', 'restorePagination',
    'scheduleSyncCheck', 'refreshItemsTotal', 'observeSentinel',
    'loadItemForDetails', 'syncDetailFallback', 'loadCollectionCounts',
  ];

  for (const name of methods) {
    assert.equal(typeof app[name], 'function', `método ausente: ${name}`);
  }
});

test('auth titles follow the current mode', () => {
  const app = createComponent();

  app.authMode = 'login';
  assert.equal(app.authTitle(), 'welcomeBack');
  assert.equal(app.authSubtitle(), 'welcomeBackSubtitle');

  app.switchAuthMode('register');
  assert.equal(app.authMode, 'register');
  assert.equal(app.authTitle(), 'createAccountTitle');

  app.switchAuthMode('forgot');
  assert.equal(app.authTitle(), 'forgotPasswordTitle');

  app.switchAuthMode('nope');
  assert.equal(app.authMode, 'forgot', 'modo inválido é ignorado');
});

test('auth validation requires email and a six character password', () => {
  const app = createComponent();
  app.authMode = 'login';
  app.authForm = { name: '', email: '', password: '' };

  const empty = app.validateAuth();
  assert.equal(empty.email, 'validatorEmailRequired');
  assert.equal(empty.password, 'validatorPasswordRequired');

  app.authForm = { name: '', email: 'not-an-email', password: '123' };
  const invalid = app.validateAuth();
  assert.equal(invalid.email, 'validatorEmailInvalid');
  assert.equal(invalid.password, 'validatorPasswordMinLength');

  app.authForm = { name: '', email: 'user@example.com', password: '123456' };
  assert.deepEqual(app.validateAuth(), {});
});

test('forgot mode does not require a password', () => {
  const app = createComponent();
  app.authMode = 'forgot';
  app.authForm = { name: '', email: 'user@example.com', password: '' };
  assert.deepEqual(app.validateAuth(), {});
});

test('register mode requires a name', () => {
  const app = createComponent();
  app.authMode = 'register';
  app.authForm = { name: '  ', email: 'user@example.com', password: '123456' };
  assert.equal(app.validateAuth().name, 'validatorNameRequired');
});

test('form validation covers name and photo, description is optional', () => {
  const app = createComponent();
  app.form = { id: null, name: '', description: '', imageBase64: '' };

  const errors = app.validateForm();
  assert.equal(errors.name, 'validatorCarNameRequired');
  assert.equal(errors.description, undefined);
  assert.equal(errors.image, 'errorCarPhotoRequired');

  app.form = { id: null, name: 'ACURA NSX', description: '', imageBase64: 'abc' };
  assert.deepEqual(app.validateForm(), {});
});

test('garage summary counts the collection', () => {
  const app = createComponent();

  app.items = [];
  assert.equal(app.garageSummary(), 'carsInGarageZero');

  app.items = [{ id: '1' }];
  assert.equal(app.garageSummary(), 'carsInGarageOne');

  app.items = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.equal(app.garageSummary(), 'carsInGarageOther');
});

test('garage summary follows the active filters', () => {
  const app = createComponent();
  app.items = [
    { id: '1', name: 'Acura NSX', description: '', collectionId: 'c1', specialEdition: false },
    { id: '2', name: 'Fusca', description: '', collectionId: '', specialEdition: false },
    { id: '3', name: 'Deora', description: '', collectionId: '', specialEdition: true },
  ];
  app.itemsTotal = 40;

  /* No filters: the whole garage. */
  assert.equal(app.garageSummary(), 'carsInGarageOther');

  /* Filters active but the full list is still loading: never show a
     partial count. */
  app.search = 'a';
  assert.equal(app.garageSummary(), 'carsFiltering');

  app.itemsSyncMode = true;
  app.itemsLoadingMore = false;
  assert.equal(app.garageSummary(), 'carsFilteredCount');

  app.specialOnly = true;
  assert.equal(app.garageSummary(), 'carsFilteredCount');

  app.search = '';
  app.specialOnly = false;
  app.itemsSyncMode = false;
  assert.equal(app.garageSummary(), 'carsInGarageOther');
});

test('search is case and accent insensitive over name, description and collection', () => {
  const app = createComponent();
  app.collections = [
    { id: 'c1', name: "HW The '90s", year: 1998 },
    { id: 'c2', name: 'Série antiga', year: 1985 },
  ];
  app.items = [
    { id: '1', name: 'Acura NSX', description: "HW THE '90S · 2/10", collectionId: 'c1', specialEdition: true },
    { id: '2', name: 'Fusca', description: 'Série antiga', collectionId: 'c2', specialEdition: false },
    { id: '3', name: 'Twin Mill', description: '', collectionId: '', specialEdition: true },
  ];

  app.search = 'nsx';
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1']);

  app.search = 'serie';
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['2']);

  app.search = 'antiga';
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['2']);

  app.search = 'hw the';
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1']);

  app.search = '   ';
  assert.equal(app.filteredItems().length, 3);

  app.search = 'nada';
  assert.equal(app.hasSearch(), true);
  assert.equal(app.filteredItems().length, 0);

  app.clearSearch();
  assert.equal(app.hasSearch(), false);
  assert.equal(app.hasItems(), true);
});

test('special edition filter combines with the search term', () => {
  const app = createComponent();
  app.collections = [{ id: 'c1', name: 'HW The 90s', year: 1998 }];
  app.items = [
    { id: '1', name: 'Acura NSX', description: '', collectionId: 'c1', specialEdition: true },
    { id: '2', name: 'Fusca', description: '', collectionId: 'c1', specialEdition: false },
    { id: '3', name: 'Twin Mill', description: '', collectionId: '', specialEdition: true },
  ];

  app.specialOnly = true;
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1', '3']);

  app.search = 'acura';
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1']);

  assert.equal(app.hasFilters(), true);
  app.clearFilters();
  assert.equal(app.specialOnly, false);
  assert.equal(app.search, '');
  assert.equal(app.hasFilters(), false);
  assert.equal(app.filteredItems().length, 3);
});

test('collection multi-select filters over one or more collections and uncategorised cars', () => {
  const app = createComponent();
  app.collections = [
    { id: 'c1', name: 'HW The 90s', year: 1998 },
    { id: 'c2', name: 'Retro Series', year: 1985 },
  ];
  app.items = [
    { id: '1', name: 'Acura NSX', description: '', collectionId: 'c1', specialEdition: false },
    { id: '2', name: 'Fusca', description: '', collectionId: 'c2', specialEdition: false },
    { id: '3', name: 'Twin Mill', description: '', collectionId: '', specialEdition: false },
    { id: '4', name: 'Deora', description: '', collectionId: 'c2', specialEdition: true },
  ];

  assert.equal(app.collectionFilterLabel(), 'filterCollectionsAll');

  app.toggleCollectionFilter('c1');
  assert.equal(app.isCollectionSelected('c1'), true);
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1']);
  assert.equal(app.collectionFilterLabel(), 'HW The 90s · 1998');

  app.toggleCollectionFilter('c2');
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1', '2', '4']);
  assert.equal(app.collectionFilterLabel(), 'filterCollectionsCount');

  app.toggleCollectionFilter('c1');
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['2', '4']);

  app.toggleCollectionFilter('');
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['2', '3', '4']);
  assert.equal(app.hasFilters(), true);

  app.clearCollectionFilter();
  assert.equal(app.selectedCollections.length, 0);
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['1', '2', '3', '4']);

  app.toggleCollectionFilter('');
  assert.equal(app.collectionFilterLabel(), 'collectionSelectNone');
  assert.deepEqual(app.filteredItems().map((item) => item.id), ['3']);
  assert.equal(app.hasFilters(), true);

  app.clearFilters();
  assert.equal(app.selectedCollections.length, 0);
  assert.equal(app.hasFilters(), false);
});

test('collection labels resolve from the managed list', () => {
  const app = createComponent();
  app.collections = [
    { id: 'c1', name: 'HW The 90s', year: 1998 },
    { id: 'c2', name: 'No year', year: 0 },
  ];

  assert.equal(app.collectionLabel(app.collections[0]), 'HW The 90s · 1998');
  assert.equal(app.collectionLabel(app.collections[1]), 'No year');
  assert.equal(app.collectionLabel(null), '');

  const item = { id: '1', collectionId: 'c1' };
  assert.equal(app.itemCollectionLabel(item), 'HW The 90s · 1998');
  assert.equal(app.itemCollectionLabel({ id: '2', collectionId: '' }), '');
  assert.equal(app.itemCollectionLabel({ id: '3', collectionId: 'missing' }), '');
  assert.equal(app.collectionFor(item).id, 'c1');
});

test('collection car counts and delete messages follow the links', () => {
  const app = createComponent();
  app.collections = [{ id: 'c1', name: 'HW The 90s', year: 1998 }];
  app.items = [
    { id: '1', collectionId: 'c1' },
    { id: '2', collectionId: 'c1' },
    { id: '3', collectionId: '' },
  ];

  assert.equal(app.collectionCarCount('c1'), 2);
  assert.equal(app.collectionCountLabel(1), 'collectionCarCountOne');

  app.collectionDelete = { open: true, target: app.collections[0], deleting: false };
  assert.equal(app.deleteCollectionMessage(), 'collectionDeleteInUseMessage');

  app.items = [{ id: '3', collectionId: '' }];
  assert.equal(app.deleteCollectionMessage(), 'collectionDeleteMessage');
});

test('collection validation requires a name and a valid year', () => {
  const app = createComponent();

  app.collectionForm = { name: '  ', year: '', returnTo: 'manage' };
  let errors = app.validateCollectionForm();
  assert.equal(errors.name, 'collectionNameRequired');
  assert.equal(errors.year, 'collectionYearRequired');

  app.collectionForm = { name: 'X'.repeat(81), year: 1998, returnTo: 'manage' };
  errors = app.validateCollectionForm();
  assert.equal(errors.name, 'collectionNameMaxLength');

  app.collectionForm = { name: 'HW', year: 1900, returnTo: 'manage' };
  errors = app.validateCollectionForm();
  assert.equal(errors.year, 'collectionYearInvalid');

  app.collectionForm = { name: 'HW', year: app.collectionFormYearMax() + 1, returnTo: 'manage' };
  errors = app.validateCollectionForm();
  assert.equal(errors.year, 'collectionYearInvalid');

  app.collectionForm = { name: 'HW The 90s', year: 1998, returnTo: 'manage' };
  assert.deepEqual(app.validateCollectionForm(), {});
});

test('detailItem only resolves on the details route', () => {
  const app = createComponent();
  app.items = [{ id: 'abc', name: 'X' }];

  app.route = { name: 'home', path: '/', params: {} };
  assert.equal(app.detailItem(), null);

  app.route = { name: 'details', path: '/collection/abc', params: { id: 'abc' } };
  assert.equal(app.detailItem().name, 'X');

  app.route = { name: 'details', path: '/collection/zzz', params: { id: 'zzz' } };
  assert.equal(app.detailItem(), null);
});

test('form titles follow the mode', () => {
  const app = createComponent();

  app.formMode = 'new';
  assert.equal(app.formTitle(), 'newCar');
  assert.equal(app.formSubtitle(), 'newCarSubtitle');

  app.formMode = 'edit';
  assert.equal(app.formTitle(), 'editCar');
  assert.equal(app.formSubtitle(), 'editCarSubtitle');
});

test('resetForm clears the form and the OCR panel', () => {
  const app = createComponent();
  app.form = { id: 'x', name: 'A', description: 'B', imageBase64: 'C', collectionId: 'c', specialEdition: true };
  app.formErrors = { name: 'erro' };
  app.formMode = 'edit';

  app.resetForm();

  assert.deepEqual(app.form, {
    id: null,
    name: '',
    description: '',
    imageBase64: '',
    collectionId: '',
    specialEdition: false,
  });
  assert.deepEqual(app.formErrors, {});
  assert.equal(app.formMode, 'new');
});

test('fillForm copies the item into the form', () => {
  const app = createComponent();

  app.fillForm({ id: '1', name: 'ACURA', description: 'HW', imageBase64: 'abc' });

  assert.equal(app.form.id, '1');
  assert.equal(app.form.name, 'ACURA');
  assert.equal(app.formMode, 'edit');
  assert.equal(app.formLoading, false);
});

test('image helpers build the data URL and the alt text', () => {
  const app = createComponent();

  assert.equal(app.imageSrc('abc'), 'data:image/jpeg;base64,abc');
  assert.equal(app.imageSrc(''), '');
  assert.equal(app.imageSrc(undefined), '');
  assert.equal(app.carPhotoAlt('Acura NSX'), 'carPhotoAlt');
});

test('delete message uses the selected item name', () => {
  const app = createComponent();

  app.deleteTarget = { id: '1', name: 'Acura NSX' };
  assert.equal(app.deleteMessage(), 'deleteCarMessage');
});

test('urls use the hash router', () => {
  const app = createComponent();
  assert.equal(app.link('/settings'), '#/settings');
});

test('theme helpers reflect the preference', () => {
  const app = createComponent();

  app.themeMode = 'dark';
  assert.equal(app.isDark(), true);

  app.themeMode = 'light';
  assert.equal(app.isDark(), false);

  app.toggleTheme();
  assert.equal(app.themeMode, 'dark');
  app.toggleTheme();
  assert.equal(app.themeMode, 'light');
});

test('palette labels are translated through the entry labelKey', () => {
  const app = createComponent();
  assert.equal(app.paletteLabel({ id: 'crimson', labelKey: 'paletteCrimson' }), 'paletteCrimson');
  assert.equal(app.paletteLabel(null), '');
});

test('invalid preference values are ignored', () => {
  const app = createComponent();

  app.themeMode = 'system';
  app.setThemeMode('neon');
  assert.equal(app.themeMode, 'system');

  app.palette = 'crimson';
  app.setPalette('rainbow');
  assert.equal(app.palette, 'crimson');

  app.locale = 'en-CA';
  app.setLocale('xx-XX');
  assert.equal(app.locale, 'en-CA');
});

test('OCR stage label maps the stage to its dictionary key', () => {
  const app = createComponent();

  app.ocr.stage = 'bottom';
  assert.equal(app.ocrStageLabel(), 'ocrStatusBottom');

  app.ocr.stage = 'numbers';
  assert.equal(app.ocrStageLabel(), 'ocrStatusNumbers');

  app.ocr.stage = 'desconhecido';
  assert.equal(app.ocrStageLabel(), 'ocrStatusLibrary');

  app.ocr.stage = null;
  assert.equal(app.ocrStageLabel(), 'ocrStatusLibrary');
});

test('user presentation falls back gracefully', () => {
  const app = createComponent();

  assert.equal(app.userDisplayName(), 'sessionUnidentified');
  assert.equal(app.userInitial(), 'S');

  app.user = { displayName: 'Wys', email: 'wys@example.com' };
  assert.equal(app.userDisplayName(), 'Wys');
  assert.equal(app.userEmail(), 'wys@example.com');
  assert.equal(app.userInitial(), 'W');

  app.user = { displayName: '', email: 'silva@example.com' };
  assert.equal(app.userDisplayName(), 'silva');
  assert.equal(app.userInitial(), 'S');
});

test('formatDate returns an empty string for invalid values', () => {
  const app = createComponent();

  assert.equal(app.formatDate(null), '');
  assert.equal(app.formatDate('não é data'), '');

  app.locale = 'en-CA';
  assert.match(app.formatDate(new Date('2024-03-05T12:00:00Z')), /2024/);
});

/* -------------------------------------------------------------------------- */
/* Smart loading (pagination + hybrid mode)                                   */
/* -------------------------------------------------------------------------- */

test('a full page keeps loading, a short page completes the list', () => {
  const app = createComponent();

  app.handleItemsSnapshot(
    Array.from({ length: 24 }, (_, index) => ({ id: `p${index}` })),
    { limit: 24, hasMore: true },
  );
  assert.equal(app.items.length, 24);
  assert.equal(app.itemsComplete, false);
  assert.equal(app.itemsLoading, false);
  assert.equal(app.itemsNeedMore(), true);

  app.handleItemsSnapshot([{ id: 'p1' }], { limit: 24, hasMore: false });
  assert.equal(app.itemsComplete, true);
  assert.equal(app.itemsNeedMore(), true, 'total desconhecido ainda permite tentar');
});

test('reaching the server total completes the list even on a full page', () => {
  const app = createComponent();
  app.itemsTotal = 50;

  app.handleItemsSnapshot(
    Array.from({ length: 24 }, (_, index) => ({ id: `p${index}` })),
    { limit: 24, hasMore: true },
  );
  assert.equal(app.itemsComplete, false);
  assert.equal(app.itemsNeedMore(), true);

  app.handleItemsSnapshot(
    Array.from({ length: 48 }, (_, index) => ({ id: `p${index}` })),
    { limit: 24, hasMore: true },
  );
  assert.equal(app.itemsComplete, false);

  app.handleItemsSnapshot(
    Array.from({ length: 50 }, (_, index) => ({ id: `p${index}` })),
    { limit: 26, hasMore: true },
  );
  assert.equal(app.itemsComplete, true);
  assert.equal(app.itemsNeedMore(), false);
});

test('the hybrid snapshot loads everything and settles the total', () => {
  const app = createComponent();
  app.itemsSyncMode = true;

  app.handleItemsSnapshot([{ id: '1' }, { id: '2' }], { limit: 0, hasMore: false });

  assert.equal(app.itemsComplete, true);
  assert.equal(app.itemsTotal, 2);
  assert.equal(app.itemsLoadingMore, false);
});

test('loadMore and the hybrid switch stay inert without a session', () => {
  const app = createComponent();

  /* No user / Firebase: every call is a safe no-op. */
  assert.doesNotThrow(() => app.loadMore());
  assert.doesNotThrow(() => app.syncAllItems());
  assert.doesNotThrow(() => app.restorePagination());
  assert.equal(app.itemsLoadingMore, false);
  assert.equal(app.itemsSyncMode, false);

  app.itemsComplete = true;
  app.user = { uid: 'u1' };
  assert.doesNotThrow(() => app.loadMore());
  assert.equal(app.itemsLoadingMore, false);
});

test('syncAllItems only reacts to an active search or filter', () => {
  const app = createComponent();
  app.user = { uid: 'u1' };

  app.syncAllItems();
  assert.equal(app.itemsSyncMode, false);

  app.search = 'fusca';
  assert.equal(app.hasFilters(), true);

  app.restorePagination();
  assert.equal(app.itemsSyncMode, false);
});

test('garage summary prefers the server total', () => {
  const app = createComponent();

  app.items = [{ id: '1' }];
  app.itemsTotal = 0;
  assert.equal(app.garageSummary(), 'carsInGarageOne');

  app.itemsTotal = 37;
  assert.equal(app.garageSummary(), 'carsInGarageOther');

  app.itemsTotal = 1;
  assert.equal(app.garageSummary(), 'carsInGarageOne');
});

test('detailItem falls back to the single document fetch', () => {
  const app = createComponent();

  app.route = { name: 'details', path: '/collection/x', params: { id: 'x' } };
  assert.equal(app.detailItem(), null);

  app.detailFallback = { id: 'x', name: 'Fallback' };
  assert.equal(app.detailItem().name, 'Fallback');

  app.items = [{ id: 'x', name: 'Carregado' }];
  assert.equal(app.detailItem().name, 'Carregado');
});

test('collection counters prefer the server aggregation when available', () => {
  const app = createComponent();
  app.items = [
    { id: '1', collectionId: 'c1' },
    { id: '2', collectionId: 'c1' },
    { id: '3', collectionId: '' },
  ];

  assert.equal(app.collectionCarCount('c1'), 2);
  assert.equal(app.collectionCarCount(''), 1);

  app.collectionCounts = { c1: 12, '': 4 };
  assert.equal(app.collectionCarCount('c1'), 12);
  assert.equal(app.collectionCarCount(''), 4);

  app.collectionCounts = {};
  assert.equal(app.collectionCarCount('c1'), 2);
});

test('handleRoute stores a plain route and closes menus', () => {
  const app = createComponent();

  app.accountMenuOpen = true;
  app.deleteOpen = true;
  app.handleRoute({
    name: 'settings',
    path: '/settings',
    params: {},
    query: new URLSearchParams('a=1'),
  });

  assert.equal(app.route.name, 'settings');
  assert.deepEqual(app.route.params, {});
  assert.equal('query' in app.route, false, 'URLSearchParams não entra no estado');
  assert.equal(app.accountMenuOpen, false);
  assert.equal(app.deleteOpen, false);
});

test('toast opens and closes', () => {
  const app = createComponent();

  app.showToast('Salvo');
  assert.equal(app.toast.open, true);
  assert.equal(app.toast.message, 'Salvo');
  assert.equal(app.toast.type, 'success');

  app.showToast('Erro', 'error');
  assert.equal(app.toast.type, 'error');

  app.hideToast();
  assert.equal(app.toast.open, false);
});

test('an empty toast message is ignored', () => {
  const app = createComponent();

  app.showToast('');
  assert.equal(app.toast.open, false);
});

/* -------------------------------------------------------------------------- */
/* Language selector                                                          */
/* -------------------------------------------------------------------------- */

test('stored preferences win over the browser defaults', () => {
  const store = new Map([
    ['wheels.locale', 'pt-BR'],
    ['wheels.themeMode', 'dark'],
    ['wheels.palette', 'ocean'],
  ]);

  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  });

  try {
    const preferences = loadPreferences();
    assert.equal(preferences.locale, 'pt-BR');
    assert.equal(preferences.themeMode, 'dark');
    assert.equal(preferences.palette, 'ocean');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('every language select marks the current option as selected', () => {
  /* `:value` on a <select> whose <option>s come from x-for runs before the
   * options exist, so the browser falls back to the first one. The selection
   * has to be declared on the option itself. */
  const selects = [...INDEX_HTML.matchAll(/<select\b[\s\S]*?<\/select>/g)].map(
    (match) => match[0],
  );
  const languageSelects = selects.filter((select) => select.includes('setLocale('));

  assert.ok(
    languageSelects.length >= 3,
    `esperava 3 seletores de idioma, encontrei ${languageSelects.length}`,
  );

  for (const select of languageSelects) {
    assert.match(
      select,
      /<option[^>]*:selected="entry\.id === locale"/,
      'opção selecionada não é marcada com :selected',
    );
  }
});
