/* Herd Hub listing form: one step-by-step form for posting and editing.
 * Loaded after the main page script; uses its globals (API, authToken,
 * currentUser, openModal, closeModal, showToast, escHtml, needsEmailConfirm,
 * showVerifyGateModal, showBeefBoxOffer, showPage, switchAcctTab,
 * loadMyListings, loadHomepageSections, loadRecentListings).
 * Steps: what -> details -> photos -> price and location -> plan -> review.
 * Farm to Table has two kinds: 'beef' (Buy Beef, category farm_to_table) and
 * 'processor' (Processors and Lockers, category processors).
 * Editing skips the plan step and opens on review.
 */
(function () {
  'use strict';

  // ── Categories ───────────────────────────────────────────
  const GROUPS = [
    { label: 'Cattle', cats: [
      ['bulls', 'Bulls', '🐂'], ['bred_heifers', 'Bred Heifers', '🐄'], ['bred_cows', 'Bred Cows', '🐄'],
      ['open_heifers', 'Open Heifers', '🐄'], ['open_cows', 'Open Cows', '🐄'], ['cow_calf_pairs', 'Cow/Calf Pairs', '🐄'],
      ['feeder_stocker', 'Feeder / Stocker', '🐃'], ['fat_cattle', 'Fat Cattle', '🥩'], ['bottle_calves', 'Bottle Calves', '🍼'],
      ['showstock', 'Showstock', '🏆'], ['dairy', 'Dairy', '🥛'], ['bucking_bulls', 'Bucking Bulls', '🤠'],
      ['full_herd', 'Full Herd', '🐄'], ['embryos', 'Embryos', '🧬'], ['semen', 'Semen', '🧬'],
    ] },
    { label: 'Equipment and supplies', cats: [
      ['equipment', 'Equipment', '🚜'], ['trailers', 'Trailers', '🚛'], ['chutes_pens', 'Chutes, Pens, Tubs', '🔩'],
      ['working_dogs', 'Working Dogs', '🐕'], ['feed_hay', 'Feed and Hay', '🌾'],
    ] },
    { label: 'Businesses and services', cats: [
      ['ranches_farms', 'Ranches and Farms', '🏡'], ['sale_barns', 'Sale Barns and Auctions', '🔨'],
      ['breed_associations', 'Breed Associations', '📜'], ['livestock_services', 'Livestock Services', '🩺'],
      ['feed_stores', 'Feed and Supply Stores', '🏪'], ['insurance_finance', 'Insurance and Finance', '🏦'],
    ] },
    { label: 'Farm to Table', cats: [['farm_to_table', 'Sell beef direct', '🥩'], ['processors', 'Processor or locker', '🏭']] },
  ];
  const CAT = {};
  GROUPS.forEach(g => g.cats.forEach(([v, l, e]) => { CAT[v] = { label: l, emoji: e, group: g.label }; }));

  function kindOf(cat) {
    if (cat === 'embryos' || cat === 'semen') return 'genetics';
    if (cat === 'working_dogs') return 'dog';
    if (['equipment', 'trailers', 'chutes_pens', 'feed_hay'].includes(cat)) return 'goods';
    if (cat === 'farm_to_table') return 'beef';
    if (cat === 'processors') return 'processor';
    if (['ranches_farms', 'sale_barns', 'breed_associations', 'livestock_services', 'feed_stores', 'insurance_finance'].includes(cat)) return 'business';
    return 'livestock';
  }
  const isF2T = cat => cat === 'farm_to_table' || cat === 'processors';
  // No head count or quantity for these kinds
  const NO_QTY = ['business', 'beef', 'processor'];

  // Farm to Table choices (values match the server's lists)
  const OPT = {
    farm_proteins: [['beef', 'Beef'], ['wagyu_beef', 'Wagyu beef'], ['bison', 'Bison'], ['pork', 'Pork'], ['lamb_goat', 'Lamb or goat'], ['chicken_poultry', 'Chicken'], ['chicken_eggs', 'Eggs'], ['other_protein', 'Other']],
    farm_product_forms: [['whole_animal', 'Whole'], ['half_animal', 'Half'], ['quarter_animal', 'Quarter'], ['custom_cuts', 'Boxes and bundles'], ['specialty_cuts', 'Retail cuts'], ['bulk_ground', 'Ground in bulk'], ['live_to_locker', 'Live animal to the locker'], ['other_form', 'Other']],
    farm_production_methods: [['grass_fed', '100% grass-fed'], ['grass_grain_finished', 'Grass-fed, grain-finished'], ['grain_fed', 'Grain-fed'], ['pasture_raised', 'Pasture-raised'], ['certified_organic', 'Certified organic'], ['no_hormones', 'No hormones or antibiotics'], ['regenerative', 'Regenerative']],
    farm_processing: [['usda_inspected', 'USDA inspected plant'], ['custom_exempt', 'Custom exempt plant'], ['buyer_arranges', 'Buyer books the processor']],
    farm_delivery: [['farm_pickup', 'Pickup at the farm'], ['local_delivery', 'Local delivery'], ['ships_regional', 'Ships in the region (frozen)'], ['ships_nationwide', 'Ships nationwide (frozen)']],
    proc_inspection: [['usda', 'USDA inspected'], ['state', 'State inspected'], ['custom_exempt', 'Custom exempt']],
    proc_species: [['beef', 'Beef'], ['hogs', 'Hogs'], ['sheep_goats', 'Sheep and goats'], ['bison', 'Bison'], ['deer_game', 'Deer and game'], ['poultry', 'Poultry']],
    proc_services: [['slaughter', 'Harvest at the plant'], ['mobile_slaughter', 'On-farm harvest'], ['cut_wrap', 'Cut and wrap'], ['sausage', 'Sausage'], ['smoking_curing', 'Smoking and curing'], ['dry_aging', 'Dry aging'], ['vacuum_pack', 'Vacuum packing']],
  };
  const AVAIL = [['ready_now', 'Ready now'], ['pre_order', 'Taking orders'], ['seasonal', 'Seasonal'], ['sold_out', 'Sold out for now']];

  const AUTO_SEX = { bulls: 'bull', bucking_bulls: 'bull', bred_heifers: 'heifer', open_heifers: 'heifer',
    bred_cows: 'cow', open_cows: 'cow', cow_calf_pairs: 'cow' };
  const ASK_SEX = ['feeder_stocker', 'fat_cattle', 'bottle_calves', 'showstock', 'dairy', 'full_herd'];

  const BREEDS = ['Aberdeen Angus','Ayrshire','Barzona','Bazadaise','Beef Shorthorn','Beefalo','Beefmaster','Belgian Blue',
    'Belmont Red','Belted Galloway','Black Angus','Blonde d\'Aquitaine','Bonsmara','Boran','Braford','Brahman','Brahmousin',
    'Brangus','British White','Brown Swiss','Buelingo','Busa','Canadienne','Caracu','Charolais','Chianina','Composite',
    'Corriente','Dairy Shorthorn','Devon','Dexter','Drakensberger','Droughtmaster','Dutch Belted','English Longhorn',
    'Fleckvieh','Friesian','Galloway','Gelbvieh','Girolando','Gloucester','Guernsey','Hays Converter','Hereford','Highland',
    'Holstein','Hybridmaster','Irish Moiled','Jersey','Kerry','Limousin','Lincoln Red','Lineback','Lowline',
    'Miniature Hereford','Mirandesa','Mongolian','Red Angus','Red Poll','Shetland','Simbrah','Simmental','South Devon',
    'Speckle Park','Square Meaters','Sussex','Texas Longhorn','Tuli','Wagyu','Watusi','Welsh Black',
    'Whitebred Shorthorn','Zebu','Mixed','Other'];
  const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA',
    'MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
    'VT','VA','WA','WV','WI','WY'];

  function priceUnits(cat) {
    const k = kindOf(cat);
    if (k === 'livestock') {
      const u = [['per_head', 'Per head'], ['per_cwt', 'Per cwt (hundredweight)'], ['per_lb', 'Per pound'], ['fixed', 'Total for the lot']];
      if (cat === 'cow_calf_pairs') u.splice(1, 0, ['per_pair', 'Per pair']);
      return u;
    }
    if (k === 'genetics') return [['each', 'Each'], ['fixed', 'Total for the lot']];
    if (k === 'business' || k === 'processor') return [];
    if (k === 'beef') return [['per_lb_hanging', 'Per lb hanging'], ['per_lb', 'Per lb take-home'], ['each', 'Per box'], ['fixed', 'Total price']];
    return [['fixed', 'Price'], ['each', 'Each']];
  }
  const UNIT_WORD = { per_lb_hanging: '/lb hanging', per_head: '/head', per_cwt: '/cwt', per_lb: '/lb', per_pair: '/pair', each: ' each', obo: ' OBO', negotiable: ', negotiable', firm: ' firm', fixed: '' };

  // ── Plans ────────────────────────────────────────────────
  const PLANS = {
    burger: { name: 'Burger', icon: '🍔', photos: 1, price: 'Free', regular: '', where: 'Browse and search, Recent Listings', days: '30 days' },
    sirloin: { name: 'Sirloin', icon: '🥩', photos: 3, price: 'Free', regular: 'Regularly <s>$5.99/mo</s>, billed yearly', where: 'Featured Cattle or Equipment row', days: '30 days free', launch: true },
    ribeye: { name: 'Ribeye', icon: '🥩', photos: 3, price: 'Free', regular: 'Regularly <s>$9.99</s> one-time', where: 'Featured Cattle or Equipment row', days: '30 days free', launch: true },
    t_bone: { name: 'Choice', icon: '⭐', photos: 5, price: 'Free', regular: 'Regularly <s>$49.99</s> one-time', where: 'Featured Ads column', days: '30 days free, reviewed before it goes live', launch: true },
    filet: { name: 'Prime', icon: '👑', photos: 5, price: 'Free', regular: 'Regularly <s>$39.99/mo</s>, billed yearly', where: 'Our Steakholders, top placement', days: '30 days free, reviewed before it goes live', launch: true },
    farm_to_table: { name: 'Farm to Table', icon: '🌿', photos: 8, price: 'Free', regular: '', where: 'Farm to Table section', days: '90 days' },
  };
  function plansFor(cat) {
    if (isF2T(cat)) return ['farm_to_table', 't_bone', 'filet'];
    return kindOf(cat) === 'business' ? ['burger', 't_bone', 'filet'] : ['burger', 'sirloin', 'ribeye'];
  }
  function maxPhotos(cat) { return Math.max(...plansFor(cat).map(p => PLANS[p].photos)); }

  // ── State ────────────────────────────────────────────────
  const DRAFT_KEY = 'hh_listing_draft_v1';
  let S = null;

  function blankData() {
    const u = me();
    return {
      category: '', title: '', breed: '', quantity: '1', weight_lbs: '', age_value: '', age_unit: 'months', sex: '',
      description: '', website_url: '', price: '', price_type: '', call: false,
      zip: '', city: u.city || '', state: u.state || '', place_ok: false,
      contact_pref: u.phone ? 'either' : 'message', phone: u.phone || '', tier: 'burger',
      farm_name: '', farm_proteins: ['beef'], farm_product_forms: [], farm_production_methods: [], farm_processing: [], farm_delivery: [],
      farm_availability: 'ready_now', farm_harvest_date: '', farm_deposit_amount: '',
      proc_inspection: [], proc_species: ['beef'], proc_services: [], proc_lead_weeks: '', proc_haul: false, proc_capacity: '',
    };
  }
  function steps() {
    return S.mode === 'edit' ? ['what', 'details', 'photos', 'price', 'review'] : ['what', 'details', 'photos', 'price', 'plan', 'review'];
  }
  const STEP_NAMES = { what: 'What are you listing?', details: 'Tell buyers about it', photos: 'Add photos',
    price: 'Price and location', plan: 'Pick a plan', review: 'Look it over' };

  // The main page declares these with let: shared by name, not on window
  const token = () => (typeof authToken !== 'undefined' ? authToken : null);
  const me = () => (typeof currentUser !== 'undefined' && currentUser) || {};
  const $ = id => document.getElementById(id);
  const esc = s => (window.escHtml ? window.escHtml(s) : String(s == null ? '' : s));
  const authHeaders = () => ({ Authorization: 'Bearer ' + token() });

  function saveDraft() {
    if (!S || S.mode !== 'new') return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), data: S.data, step: S.step })); } catch (e) {}
  }
  function readDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (d && d.data && d.data.category && Date.now() - d.at < 14 * 86400000) return d;
    } catch (e) {}
    return null;
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

  // ── Open ─────────────────────────────────────────────────
  async function openListingForm(opts) {
    opts = opts || {};
    if (!token()) {
      window._afterLogin = () => openListingForm(opts);
      if (window.showToast) showToast('Sign in or create a free account to post.');
      openModal('auth');
      return;
    }
    if (!opts.editId && typeof needsEmailConfirm === 'function' && needsEmailConfirm()) { showVerifyGateModal(); return; }

    S = { mode: opts.editId ? 'edit' : 'new', id: opts.editId || null, step: 0, data: blankData(),
      photos: [], removed: [], original: null, featuredTrial: null, busy: false, draftOffer: null, presetPlan: opts.plan || null };

    if (S.mode === 'edit') {
      $('lf-heading').textContent = 'Edit Listing';
      showModal();
      $('lf-body').innerHTML = '<div class="loading" style="padding:40px;text-align:center">Loading your listing…</div>';
      setNav(false);
      try {
        const r = await fetch(`${API}/api/listings/${opts.editId}/mine`, { headers: authHeaders() });
        const l = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(l.error || 'Could not load your listing.');
        S.original = l;
        const months = l.age_months == null ? '' : Number(l.age_months);
        const inYears = months !== '' && months >= 24 && months % 12 === 0;
        Object.assign(S.data, {
          category: l.category, title: l.title || '', breed: l.breed || '', quantity: String(l.quantity || 1),
          weight_lbs: l.weight_lbs == null ? '' : String(Number(l.weight_lbs)),
          age_value: months === '' ? '' : String(inYears ? months / 12 : months), age_unit: inYears ? 'years' : 'months',
          sex: l.sex || '', description: l.description || '', website_url: l.website_url || '',
          price: l.price == null ? '' : String(Number(l.price)), price_type: l.price_type || 'fixed', call: l.price_type === 'call',
          zip: l.zip || '', city: l.city || '', state: l.state || '', place_ok: true,
          contact_pref: l.contact_pref || 'either', phone: me().phone || '', tier: l.tier,
          farm_name: l.farm_name || '', farm_availability: l.farm_availability || 'ready_now',
          farm_harvest_date: l.farm_harvest_date ? String(l.farm_harvest_date).slice(0, 10) : '',
          farm_deposit_amount: l.farm_deposit_amount == null ? '' : String(Number(l.farm_deposit_amount)),
          proc_lead_weeks: l.proc_lead_weeks == null ? '' : String(l.proc_lead_weeks), proc_haul: !!l.proc_haul,
          proc_capacity: l.proc_capacity == null ? '' : String(l.proc_capacity),
        });
        Object.keys(OPT).forEach(key => { S.data[key] = (l[key] || []).filter(v => OPT[key].some(o => o[0] === v)); });
        S.photos = (l.photos || []).map(p => ({ kind: 'old', id: Number(p.id), url: p.thumb_url || p.url }));
        S.photoLimit = l.photo_limit || (PLANS[l.tier] || {}).photos || 1;
        S.step = steps().indexOf('review');
        render();
      } catch (e) {
        $('lf-body').innerHTML = `<p class="lf-msg lf-msg-bad">${esc(e.message)}</p>`;
      }
      return;
    }

    $('lf-heading').textContent = 'Post a Listing';
    // Opened from a Farm to Table button: start on that category's details
    if (opts.category && CAT[opts.category]) {
      S.data.category = opts.category;
      S.data.tier = (S.presetPlan && plansFor(opts.category).includes(S.presetPlan)) ? S.presetPlan : plansFor(opts.category)[0];
      S.step = steps().indexOf('details');
    } else {
      const draft = readDraft();
      if (draft) S.draftOffer = draft;
    }
    showModal();
    render();
    loadFeaturedTrial();
  }
  window.openListingForm = openListingForm;

  function showModal() {
    const el = $('modal-listing-form');
    el.classList.add('open');
    el.removeAttribute('aria-hidden');
    document.body.style.overflow = 'hidden';
  }
  function closeForm() {
    revokeAll();
    if (typeof closeModal === 'function') closeModal('listing-form');
  }

  async function loadFeaturedTrial() {
    try {
      const r = await fetch(`${API}/api/listings/user/me/plans`, { headers: authHeaders() });
      if (r.ok) { const d = await r.json(); S.featuredTrial = d.featured_trial || null; }
    } catch (e) {}
    if (S && steps()[S.step] === 'plan') render();
  }

  // ── Rendering ────────────────────────────────────────────
  function render() {
    const st = steps();
    const name = st[S.step];
    $('lf-stepname').textContent = `Step ${S.step + 1} of ${st.length}: ${STEP_NAMES[name]}`;
    $('lf-progress-bar').style.width = Math.round(((S.step + 1) / st.length) * 100) + '%';
    hideError();
    const body = $('lf-body');
    body.innerHTML = ({ what: viewWhat, details: viewDetails, photos: viewPhotos, price: viewPrice, plan: viewPlan, review: viewReview })[name]();
    wire(name);
    setNav(true);
    $('lf-back').style.visibility = S.step === 0 ? 'hidden' : 'visible';
    const next = $('lf-next');
    if (name === 'review') next.textContent = S.mode === 'edit' ? 'Save Changes' : 'Post Listing';
    else if (name === 'what') next.textContent = 'Next →';
    else next.textContent = 'Next →';
    next.style.display = (name === 'what' && !S.data.category) ? 'none' : '';
    const modal = document.querySelector('#modal-listing-form .modal');
    if (modal) modal.scrollTop = 0;
  }
  function setNav(on) { $('lf-back').disabled = !on; $('lf-next').disabled = !on; }

  function field(id, label, input, hint) {
    return `<div class="form-group lf-field" id="lf-f-${id}"><label for="lf-${id}">${label}</label>${input}${hint ? `<div class="lf-hint">${hint}</div>` : ''}<div class="lf-ferr" id="lf-e-${id}"></div></div>`;
  }

  // A group of checkboxes for a Farm to Table list field
  function checks(key, label, hint) {
    const cur = S.data[key] || [];
    return `<div class="form-group lf-field" id="lf-f-${key}"><label>${label}</label><div class="lf-checks">${
      OPT[key].map(([v, l]) => `<label class="lf-check"><input type="checkbox" data-arr="${key}" value="${v}" ${cur.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')
    }</div>${hint ? `<div class="lf-hint">${hint}</div>` : ''}<div class="lf-ferr" id="lf-e-${key}"></div></div>`;
  }

  function viewWhat() {
    let html = '';
    if (S.draftOffer && S.mode === 'new') {
      const d = S.draftOffer.data;
      html += `<div class="lf-draft">You have an unfinished listing${d.title ? `: <strong>${esc(d.title)}</strong>` : ` (${esc((CAT[d.category] || {}).label || '')})`}. Photos need adding again.
        <div class="lf-draft-btns"><button type="button" class="btn-primary" data-lf="draft-continue">Pick up where I left off</button>
        <button type="button" class="btn-secondary" data-lf="draft-discard">Start over</button></div></div>`;
    }
    let groups = GROUPS;
    if (S.mode === 'edit') {
      // Editing keeps the listing where its plan works: Farm to Table stays put,
      // business plans stay with businesses, seller plans stay with cattle and equipment.
      if (isF2T(S.data.category)) return `<p class="lf-lead">Farm to Table listings stay in the Farm to Table section. Tap Next to edit the details.</p>`;
      const biz = ['t_bone', 'filet'].includes(S.data.tier), seller = ['sirloin', 'ribeye'].includes(S.data.tier);
      groups = GROUPS.filter(g => g.label !== 'Farm to Table' && (biz ? g.label === 'Businesses and services' : seller ? g.label !== 'Businesses and services' : true));
    }
    html += groups.map(g => `<div class="lf-group"><div class="lf-group-label">${g.label}</div><div class="lf-tiles">${
      g.cats.map(([v, l, e]) => `<button type="button" class="lf-tile${S.data.category === v ? ' selected' : ''}" data-lf="cat" data-v="${v}" aria-pressed="${S.data.category === v}"><span class="lf-tile-emoji">${e}</span><span>${l}</span></button>`).join('')
    }</div></div>`).join('');
    if (S.mode === 'edit') html = `<p class="lf-hint" style="margin-bottom:12px">Changing the category moves your listing to that section.</p>` + html;
    return html;
  }

  function viewDetails() {
    const d = S.data, cat = d.category, k = kindOf(cat);
    const catInfo = CAT[cat] || { label: cat, emoji: '' };
    const examples = { livestock: 'e.g. 12 Black Angus Bred Heifers, due March', genetics: 'e.g. Registered Angus semen, 10 straws',
      dog: 'e.g. Started Border Collie, 2 yr, working cattle', goods: 'e.g. 2019 W-W Cattle Chute, used one season', business: 'e.g. Smith Ranch Supply, Amarillo',
      beef: 'e.g. Grass-fed beef halves and quarters', processor: 'e.g. Smith Meat Processing, Amarillo' };
    let html = `<div class="lf-chip">${catInfo.emoji} ${esc(catInfo.label)} <button type="button" class="lf-link" data-lf="goto" data-step="what">Change</button></div>`;
    html += field('title', k === 'business' || k === 'processor' ? 'Business name and headline' : 'Title',
      `<input type="text" id="lf-title" maxlength="120" value="${esc(d.title)}" placeholder="${examples[k]}">`,
      { business: 'Buyers see this first. Your business name and what you do.', processor: 'Buyers see this first. Your business name and town.', beef: 'Buyers see this first. Say what you sell, like halves and quarters.' }[k] || 'Buyers see this first. Say what it is and how many.');
    if (k === 'livestock' || k === 'genetics') {
      html += field('breed', 'Breed', `<select id="lf-breed"><option value="">Pick a breed (optional)</option>${BREEDS.map(b => `<option${d.breed === b ? ' selected' : ''}>${esc(b)}</option>`).join('')}${d.breed && !BREEDS.includes(d.breed) ? `<option selected>${esc(d.breed)}</option>` : ''}</select>`);
    }
    if (k === 'dog') html += field('breed', 'Breed', `<input type="text" id="lf-breed" maxlength="60" value="${esc(d.breed)}" placeholder="e.g. Border Collie">`);
    if (k === 'beef') {
      html += field('farm_name', 'Farm or ranch name (optional)', `<input type="text" id="lf-farm_name" maxlength="150" value="${esc(d.farm_name)}" placeholder="e.g. Harrington Ranch">`);
      html += checks('farm_proteins', 'What do you sell?');
      html += checks('farm_product_forms', 'How do you sell it?');
      html += checks('farm_production_methods', 'How is it raised? (optional)');
      html += checks('farm_processing', 'Where is it processed? (optional)', 'Buyers ask. USDA inspected beef can be sold by the cut; custom exempt is sold by the share before harvest.');
    }
    if (k === 'processor') {
      html += checks('proc_inspection', 'Inspection type');
      html += checks('proc_species', 'What do you process?');
      html += checks('proc_services', 'What services do you offer?');
      html += `<div class="form-row">` +
        field('proc_lead_weeks', 'Booking how far out? (weeks)', `<input type="number" id="lf-proc_lead_weeks" inputmode="numeric" min="0" max="104" value="${esc(d.proc_lead_weeks)}" placeholder="0 = taking animals now">`) +
        field('proc_capacity', 'Head per week (optional)', `<input type="number" id="lf-proc_capacity" inputmode="numeric" min="1" value="${esc(d.proc_capacity)}" placeholder="optional">`) + `</div>`;
      html += `<label class="lf-check"><input type="checkbox" id="lf-proc_haul" ${d.proc_haul ? 'checked' : ''}> We can pick up live animals</label>`;
    }
    if (!NO_QTY.includes(k)) {
      const qLabel = { livestock: 'How many head?', genetics: cat === 'semen' ? 'How many straws?' : 'How many embryos?', dog: 'How many dogs?', goods: 'How many?' }[k];
      html += `<div class="form-row">` + field('quantity', qLabel, `<input type="number" id="lf-quantity" inputmode="numeric" min="1" value="${esc(d.quantity)}">`);
      if (k === 'livestock') html += field('weight', 'Average weight (lb)', `<input type="number" id="lf-weight" inputmode="decimal" min="1" max="5000" value="${esc(d.weight_lbs)}" placeholder="optional">`);
      html += `</div>`;
    }
    if (k === 'livestock' || k === 'dog') {
      const withSex = k === 'livestock' && ASK_SEX.includes(cat);
      html += (withSex ? `<div class="form-row">` : '') + field('age', 'Age', `<div class="lf-inline"><input type="number" id="lf-age" inputmode="numeric" min="0" value="${esc(d.age_value)}" placeholder="optional"><select id="lf-age-unit"><option value="months"${d.age_unit === 'months' ? ' selected' : ''}>months</option><option value="years"${d.age_unit === 'years' ? ' selected' : ''}>years</option></select></div>`);
      if (withSex) {
        html += field('sex', 'Steers or heifers?', `<select id="lf-sex"><option value="">Mixed or not sure</option>${[['steer', 'Steers'], ['heifer', 'Heifers'], ['bull', 'Bulls'], ['cow', 'Cows'], ['calf', 'Calves']].map(([v, l]) => `<option value="${v}"${d.sex === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`);
        html += `</div>`;
      }
    }
    if (k === 'business' || k === 'beef' || k === 'processor') html += field('website', 'Website (optional)', `<input type="url" id="lf-website" inputmode="url" value="${esc(d.website_url)}" placeholder="https://yourranch.com">`);
    const descHint = { livestock: 'Health and vaccinations, breeding or calving dates, temperament, papers, why you are selling.',
      genetics: 'Sire or dam, registration numbers, EPDs, storage and shipping.', dog: 'Training, temperament, papers, what stock they work.',
      goods: 'Year, make and model, condition, hours or miles, what is included.', business: 'What you offer, who you serve, hours, how to reach you.',
      beef: 'Breed, how the cattle are raised and finished, typical hanging weight, what a share includes, how ordering and pickup work.',
      processor: 'Hours, how to book, drop-off days, what customers bring or pay, anything buyers should know.' }[k];
    html += field('description', 'Description', `<textarea id="lf-description" rows="5" maxlength="5000" placeholder="Write a few lines for buyers">${esc(d.description)}</textarea>`, descHint);
    return html;
  }

  function viewPhotos() {
    const max = S.mode === 'edit' ? S.photoLimit : maxPhotos(S.data.category);
    const n = S.photos.length;
    let html = `<p class="lf-lead">Good photos sell. Take them in daylight, from the side, with the whole animal or item in frame.</p>`;
    html += `<div class="lf-photo-btns">
      <button type="button" class="btn-primary" data-lf="camera" ${n >= max ? 'disabled' : ''}>📷 Take a photo</button>
      <button type="button" class="btn-secondary" data-lf="library" ${n >= max ? 'disabled' : ''}>🖼 Choose from your photos</button></div>`;
    html += `<div class="lf-hint" style="margin:8px 0 14px">${n} of ${max} photos${S.mode === 'new' ? (isF2T(S.data.category) ? '. The Farm to Table plan shows up to 8.' : kindOf(S.data.category) === 'business' ? '. The free plan shows 1; Choice and Prime show up to 5.' : '. The free plan shows 1; Sirloin and Ribeye show up to 3.') : ` for the ${esc((PLANS[S.data.tier] || {}).name || S.data.tier)} plan.`} The first photo is the cover.</div>`;
    html += `<div class="lf-photos" id="lf-photos">${S.photos.map((p, i) => `
      <div class="lf-photo">
        <img src="${esc(p.url)}" alt="Photo ${i + 1}">
        ${i === 0 ? '<span class="lf-cover">Cover</span>' : ''}
        <div class="lf-photo-tools">
          ${i > 0 ? `<button type="button" data-lf="ph-left" data-i="${i}" aria-label="Move photo ${i + 1} earlier">◀</button>` : '<span></span>'}
          ${i > 0 ? `<button type="button" data-lf="ph-cover" data-i="${i}">Make cover</button>` : '<span></span>'}
          ${i < n - 1 ? `<button type="button" data-lf="ph-right" data-i="${i}" aria-label="Move photo ${i + 1} later">▶</button>` : '<span></span>'}
        </div>
        <button type="button" class="lf-photo-x" data-lf="ph-remove" data-i="${i}" aria-label="Remove photo ${i + 1}">✕</button>
      </div>`).join('')}</div>`;
    if (S.processing) html += `<div class="lf-hint">Getting your photos ready…</div>`;
    return html;
  }

  function viewPrice() {
    const d = S.data, k = kindOf(d.category);
    let html = '';
    if (k !== 'business' && k !== 'processor') {
      const units = priceUnits(d.category);
      if (!d.price_type || (d.price_type === 'call' && !d.call)) d.price_type = units[0][0];
      const cur = d.call ? units[0][0] : d.price_type;
      const extra = !units.some(u => u[0] === cur) ? `<option value="${esc(cur)}" selected>${esc(cur.replace(/_/g, ' '))}</option>` : '';
      html += `<div class="form-row">` +
        field('price', 'Price ($)', `<input type="number" id="lf-price" inputmode="decimal" min="0" step="0.01" value="${esc(d.price)}" ${d.call ? 'disabled' : ''} placeholder="0">`) +
        field('unit', 'Priced', `<select id="lf-unit" ${d.call ? 'disabled' : ''}>${units.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('')}${extra}</select>`) +
        `</div><label class="lf-check"><input type="checkbox" id="lf-call" ${d.call ? 'checked' : ''}> Call for price (no price shown)</label>`;
    }
    if (k === 'beef') {
      html += field('farm_deposit_amount', 'Deposit to hold an order ($, optional)', `<input type="number" id="lf-farm_deposit_amount" inputmode="decimal" min="0" step="1" value="${esc(d.farm_deposit_amount)}" placeholder="optional">`);
      html += checks('farm_delivery', 'How do buyers get it?');
      html += `<div class="form-row">` +
        field('farm_availability', 'When is it ready?', `<select id="lf-farm_availability">${AVAIL.map(([v, l]) => `<option value="${v}"${d.farm_availability === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`) +
        field('farm_harvest_date', 'Next harvest date (optional)', `<input type="date" id="lf-farm_harvest_date" value="${esc(d.farm_harvest_date)}">`) + `</div>`;
    }
    html += field('zip', 'ZIP code', `<input type="text" id="lf-zip" inputmode="numeric" autocomplete="postal-code" maxlength="5" value="${esc(d.zip)}" placeholder="e.g. 79101">`,
      'We use it to fill in your town and put the listing on the map. Buyers see the town, never the ZIP.');
    html += `<div id="lf-place">${placeHtml()}</div>`;
    const opt = (v, l) => `<label class="lf-radio"><input type="radio" name="lf-contact" value="${v}" ${d.contact_pref === v ? 'checked' : ''}> ${l}</label>`;
    html += `<div class="form-group lf-field"><label>How should buyers reach you?</label>
      ${opt('message', 'Message me on Herd Hub')}
      ${opt('phone', 'Call or text me')}
      ${opt('either', 'Either one')}
      <div class="lf-ferr" id="lf-e-contact"></div></div>
      <div id="lf-phone-wrap"${d.contact_pref === 'message' ? ' hidden' : ''}>` +
      field('phone', 'Your phone number', `<input type="tel" id="lf-phone" inputmode="tel" autocomplete="tel" maxlength="20" value="${esc(d.phone || '')}" placeholder="(806) 555-1234">`,
        'Shows only to signed-in buyers. It is saved to your account for your other listings too.') + `</div>`;
    return html;
  }
  function placeHtml() {
    const d = S.data;
    if (d.place_ok && d.city && d.state && !S.editPlace) {
      return `<div class="lf-place-ok">📍 ${esc(d.city)}, ${esc(d.state)} <button type="button" class="lf-link" data-lf="edit-place">Not right? Change it</button></div><div class="lf-ferr" id="lf-e-place"></div>`;
    }
    return `<div class="form-row">` +
      field('city', 'Town or city', `<input type="text" id="lf-city" maxlength="80" value="${esc(d.city)}" placeholder="e.g. Amarillo">`) +
      field('state', 'State', `<select id="lf-state"><option value="">State</option>${STATES.map(s => `<option${d.state === s ? ' selected' : ''}>${s}</option>`).join('')}</select>`) +
      `</div><div class="lf-ferr" id="lf-e-place"></div>`;
  }

  function viewPlan() {
    const cat = S.data.category;
    const n = S.photos.length;
    let html = `<div class="launch-note">Paid plans are free to try while we launch. You won't be charged, and nothing renews on its own. When the free run ends, your listing stays up as a regular listing.</div><div class="lf-plans">`;
    html += plansFor(cat).map(p => {
      const P = PLANS[p];
      const blocked = S.featuredTrial && (p === 'sirloin' || p === 'ribeye');
      const sel = S.data.tier === p;
      const photoNote = n > P.photos ? `<div class="lf-plan-warn">Shows your first ${P.photos} photo${P.photos > 1 ? 's' : ''}</div>` : '';
      return `<button type="button" class="lf-plan${sel ? ' selected' : ''}${blocked ? ' blocked' : ''}" data-lf="plan" data-v="${p}" aria-pressed="${sel}" ${blocked ? 'aria-disabled="true"' : ''}>
        ${P.launch ? '<span class="plan-card-badge pcb-launch">Free during launch</span>' : '<span class="plan-card-badge pcb-free">Free</span>'}
        <span class="lf-plan-name">${P.icon} ${P.name}</span>
        <span class="lf-plan-price">${P.price}</span>
        ${P.regular ? `<span class="plan-card-regular">${P.regular}</span>` : ''}
        <span class="lf-plan-feat">${P.photos} photo${P.photos > 1 ? 's' : ''} · ${P.where}<br>${P.days}</span>
        ${blocked ? `<span class="plan-unavailable-note">You have one running: "${esc(S.featuredTrial.title)}". One free featured spot at a time while we launch.</span>` : photoNote}
      </button>`;
    }).join('');
    return html + '</div>';
  }

  function viewReview() {
    const d = S.data, k = kindOf(d.category);
    const cover = S.photos[0];
    const limit = S.mode === 'edit' ? S.photoLimit : (PLANS[d.tier] || PLANS.burger).photos;
    const price = (k === 'business' || k === 'processor') ? '' : d.call || !d.price ? 'Call for price' : '$' + Number(d.price).toLocaleString() + (UNIT_WORD[d.price_type] || '');
    const words = key => (d[key] || []).map(v => (OPT[key].find(o => o[0] === v) || [v, v])[1]).join(', ');
    const pills = [];
    if (k === 'beef') { if (d.farm_name) pills.push(esc(d.farm_name)); if (words('farm_product_forms')) pills.push(esc(words('farm_product_forms'))); if (words('farm_production_methods')) pills.push(esc(words('farm_production_methods'))); }
    if (k === 'processor') { pills.push(esc(words('proc_inspection'))); pills.push(esc(words('proc_species'))); if (d.proc_lead_weeks !== '') pills.push(Number(d.proc_lead_weeks) === 0 ? 'Taking animals now' : `Booking ${esc(d.proc_lead_weeks)} weeks out`); if (d.proc_haul) pills.push('Picks up live animals'); }
    if (d.breed) pills.push(esc(d.breed));
    if (!NO_QTY.includes(k) && Number(d.quantity) > 1) pills.push(`${esc(d.quantity)} ${k === 'livestock' ? 'head' : ''}`.trim());
    if (d.weight_lbs) pills.push(`${Number(d.weight_lbs).toLocaleString()} lb avg`);
    if (d.age_value) pills.push(`${esc(d.age_value)} ${d.age_unit}`);
    const contact = { message: 'Herd Hub messages', phone: 'Call or text', either: 'Messages, call or text' }[d.contact_pref];
    const row = (label, value, step) => `<div class="lf-sum-row"><div><div class="lf-sum-label">${label}</div><div class="lf-sum-val">${value}</div></div>${step ? `<button type="button" class="lf-link" data-lf="goto" data-step="${step}">Change</button>` : ''}</div>`;
    let html = `<div class="lf-preview">
      ${cover ? `<img src="${esc(cover.url)}" alt="">` : `<div class="lf-preview-empty">${(CAT[d.category] || {}).emoji || '📷'}</div>`}
      <div class="lf-preview-body"><div class="lf-preview-cat">${esc((CAT[d.category] || {}).label || d.category)}</div>
      <div class="lf-preview-title">${esc(d.title || 'Untitled')}</div>
      ${price ? `<div class="lf-preview-price">${esc(price)}</div>` : ''}
      <div class="lf-preview-loc">📍 ${esc(d.city)}, ${esc(d.state)}</div></div></div>`;
    html += `<div class="lf-sum">`;
    html += row('Category', esc((CAT[d.category] || {}).label || d.category), 'what');
    html += row('Details', `${esc(d.title)}${pills.length ? '<br>' + pills.join(' · ') : ''}`, 'details');
    html += row('Photos', `${S.photos.length} photo${S.photos.length === 1 ? '' : 's'}${S.photos.length > limit ? `. This plan shows your first ${limit}.` : ''}`, 'photos');
    const beefExtra = k === 'beef' ? `${words('farm_delivery') ? esc(words('farm_delivery')) + '<br>' : ''}${esc((AVAIL.find(a => a[0] === d.farm_availability) || ['', ''])[1])}${d.farm_harvest_date ? ', next harvest ' + esc(new Date(d.farm_harvest_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) : ''}${d.farm_deposit_amount ? `<br>$${esc(d.farm_deposit_amount)} deposit` : ''}<br>` : '';
    html += row(k === 'processor' ? 'Location' : 'Price and location', `${price ? esc(price) + '<br>' : ''}${beefExtra}${esc(d.city)}, ${esc(d.state)}${d.zip ? ' ' + esc(d.zip) : ''}<br>Buyers reach you by: ${contact}${d.contact_pref !== 'message' && d.phone ? ' at ' + esc(d.phone) : ''}`, 'price');
    const P = PLANS[d.tier] || { name: d.tier };
    html += row('Plan', `${P.icon || ''} ${esc(P.name)}${P.launch ? ', free during launch' : ', free'}${d.tier === 't_bone' || d.tier === 'filet' ? '. Reviewed by hand before it goes live.' : ''}`, S.mode === 'new' ? 'plan' : null);
    html += `</div>`;
    if (S.mode === 'new') html += `<p class="lf-terms">By posting you confirm the listing is accurate and you agree to our <a href="javascript:void(0)" data-action="page" data-page="terms">Terms of Service</a> and <a href="javascript:void(0)" data-action="page" data-page="user-agreement">User Agreement</a>, including seller responsibilities for livestock compliance.</p>`;
    return html;
  }

  // ── Wiring ───────────────────────────────────────────────
  function wire(name) {
    const d = S.data;
    const bind = (id, key, fn) => { const el = $(id); if (el) el.addEventListener('input', () => { d[key] = fn ? fn(el.value) : el.value; saveDraft(); }); if (el && el.tagName === 'SELECT') el.addEventListener('change', () => { d[key] = el.value; saveDraft(); }); };
    if (name === 'details') {
      bind('lf-title', 'title'); bind('lf-breed', 'breed'); bind('lf-quantity', 'quantity'); bind('lf-weight', 'weight_lbs');
      bind('lf-age', 'age_value'); bind('lf-age-unit', 'age_unit'); bind('lf-sex', 'sex'); bind('lf-website', 'website_url'); bind('lf-description', 'description');
      bind('lf-farm_name', 'farm_name'); bind('lf-proc_lead_weeks', 'proc_lead_weeks'); bind('lf-proc_capacity', 'proc_capacity');
      const haul = $('lf-proc_haul'); if (haul) haul.addEventListener('change', () => { d.proc_haul = haul.checked; saveDraft(); });
    }
    document.querySelectorAll('#lf-body input[data-arr]').forEach(cb => cb.addEventListener('change', () => {
      const key = cb.dataset.arr, set = new Set(d[key] || []);
      if (cb.checked) set.add(cb.value); else set.delete(cb.value);
      d[key] = OPT[key].map(o => o[0]).filter(v => set.has(v)); saveDraft();
    }));
    if (name === 'price') {
      bind('lf-price', 'price'); bind('lf-unit', 'price_type');
      bind('lf-farm_deposit_amount', 'farm_deposit_amount'); bind('lf-farm_availability', 'farm_availability'); bind('lf-farm_harvest_date', 'farm_harvest_date');
      const call = $('lf-call');
      if (call) call.addEventListener('change', () => { d.call = call.checked; $('lf-price').disabled = call.checked; $('lf-unit').disabled = call.checked; saveDraft(); });
      document.querySelectorAll('input[name="lf-contact"]').forEach(r => r.addEventListener('change', () => { d.contact_pref = r.value; const w = $('lf-phone-wrap'); if (w) w.hidden = r.value === 'message'; saveDraft(); }));
      bind('lf-phone', 'phone');
      const zip = $('lf-zip');
      zip.addEventListener('input', () => {
        zip.value = zip.value.replace(/\D/g, '').slice(0, 5);
        d.zip = zip.value; saveDraft();
        if (zip.value.length === 5) lookupZip(zip.value);
      });
      wirePlace();
    }
  }
  function wirePlace() {
    const d = S.data;
    const city = $('lf-city'), state = $('lf-state');
    if (city) city.addEventListener('input', () => { d.city = city.value; d.place_ok = false; saveDraft(); });
    if (state) state.addEventListener('change', () => { d.state = state.value; d.place_ok = false; saveDraft(); });
  }
  async function lookupZip(zip) {
    const err = $('lf-e-zip');
    try {
      const r = await fetch(`${API}/api/listings/zip-lookup/${zip}`);
      if (!r.ok) throw new Error();
      const z = await r.json();
      if (S.data.zip !== zip) return;
      Object.assign(S.data, { city: z.city, state: z.state, place_ok: true });
      S.editPlace = false;
      if (err) err.textContent = '';
    } catch (e) {
      if (err) err.textContent = "We couldn't find that ZIP. Check it, or enter your town and state below.";
      S.data.place_ok = false; S.editPlace = true;
    }
    saveDraft();
    const p = $('lf-place'); if (p) { p.innerHTML = placeHtml(); wirePlace(); }
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('#modal-listing-form [data-lf]');
    if (!el || !S) return;
    const a = el.dataset.lf;
    if (a === 'cat') {
      const v = el.dataset.v;
      const changedKind = S.data.category && kindOf(S.data.category) !== kindOf(v);
      S.data.category = v;
      S.data.sex = AUTO_SEX[v] || (ASK_SEX.includes(v) ? S.data.sex : '');
      if (changedKind) { S.data.price_type = ''; }
      if (S.mode === 'new' && !plansFor(v).includes(S.data.tier)) S.data.tier = plansFor(v)[0];
      if (S.mode === 'new' && S.presetPlan && plansFor(v).includes(S.presetPlan)) S.data.tier = S.presetPlan;
      S.draftOffer = null; saveDraft();
      S.step = steps().indexOf('details'); render();
    } else if (a === 'draft-continue') {
      const dr = S.draftOffer; S.draftOffer = null;
      Object.assign(S.data, dr.data);
      S.step = Math.min(steps().indexOf('photos'), Math.max(1, dr.step || 1)); render();
    } else if (a === 'draft-discard') {
      clearDraft(); S.draftOffer = null; S.data = blankData(); render();
    } else if (a === 'goto') {
      S.step = steps().indexOf(el.dataset.step); render();
    } else if (a === 'camera') { $('lf-camera').click(); }
    else if (a === 'library') { $('lf-library').click(); }
    else if (a === 'ph-left' || a === 'ph-right' || a === 'ph-cover') {
      const i = Number(el.dataset.i);
      const to = a === 'ph-left' ? i - 1 : a === 'ph-right' ? i + 1 : 0;
      const [p] = S.photos.splice(i, 1); S.photos.splice(to, 0, p); render();
    } else if (a === 'ph-remove') {
      const [p] = S.photos.splice(Number(el.dataset.i), 1);
      if (p.kind === 'old') S.removed.push(p.id); else URL.revokeObjectURL(p.url);
      render();
    } else if (a === 'edit-place') { S.editPlace = true; const p = $('lf-place'); p.innerHTML = placeHtml(); wirePlace(); }
    else if (a === 'plan') {
      if (el.classList.contains('blocked')) { showToast('You already have a featured listing running. One free featured spot at a time while we launch.'); return; }
      S.data.tier = el.dataset.v; saveDraft(); render();
    }
  });

  // ── Photos: shrink, turn upright, keep order ─────────────
  async function shrink(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      src = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('unreadable'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
    const s = Math.min(1, 2000 / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) throw new Error('unreadable');
    return blob;
  }
  async function addFiles(files) {
    const max = S.mode === 'edit' ? S.photoLimit : maxPhotos(S.data.category);
    const room = max - S.photos.length;
    const list = Array.from(files || []);
    if (!list.length) return;
    if (list.length > room) showToast(`Only ${room} more photo${room === 1 ? '' : 's'} fit. Added the first ${Math.max(room, 0)}.`);
    S.processing = true; render();
    let bad = 0;
    for (const f of list.slice(0, Math.max(room, 0))) {
      try {
        const blob = await shrink(f);
        S.photos.push({ kind: 'new', blob, url: URL.createObjectURL(blob) });
      } catch (e) { bad++; }
    }
    S.processing = false;
    render();
    if (bad) showError(`${bad} photo${bad > 1 ? 's' : ''} couldn't be read. Try a JPG or PNG, or take the photo again with your camera.`);
  }
  ['lf-camera', 'lf-library'].forEach(id => {
    const inp = $(id);
    if (inp) inp.addEventListener('change', () => { const f = inp.files; addFiles(f).finally(() => { inp.value = ''; }); });
  });
  function revokeAll() { if (S) S.photos.forEach(p => { if (p.kind === 'new') URL.revokeObjectURL(p.url); }); }

  // ── Checks before moving on ──────────────────────────────
  function fieldErr(id, msg) { const e = $('lf-e-' + id); if (e) e.textContent = msg; const f = $('lf-' + id); if (f && f.focus && !fieldErr.focused) { f.focus(); fieldErr.focused = true; } }
  function check(name) {
    fieldErr.focused = false;
    document.querySelectorAll('#lf-body .lf-ferr').forEach(e => { e.textContent = ''; });
    const d = S.data, k = kindOf(d.category);
    let ok = true;
    const bad = (id, msg) => { ok = false; fieldErr(id, msg); };
    if (name === 'details') {
      if ((d.title || '').trim().length < 5) bad('title', 'Give it a title of at least a few words.');
      if (!NO_QTY.includes(k) && !(parseInt(d.quantity) >= 1)) bad('quantity', 'Enter 1 or more.');
      const need = (key, msg) => { if (!(d[key] || []).length) bad(key, msg); };
      if (k === 'beef') { need('farm_proteins', 'Pick at least one thing you sell.'); need('farm_product_forms', 'Pick at least one way you sell it.'); }
      if (k === 'processor') {
        need('proc_inspection', 'Pick your inspection type.'); need('proc_species', 'Pick at least one.'); need('proc_services', 'Pick at least one.');
        if (d.proc_lead_weeks !== '' && !(Number.isInteger(Number(d.proc_lead_weeks)) && Number(d.proc_lead_weeks) >= 0 && Number(d.proc_lead_weeks) <= 104)) bad('proc_lead_weeks', 'Enter whole weeks from 0 to 104, or leave it blank.');
        if (d.proc_capacity !== '' && !(Number.isInteger(Number(d.proc_capacity)) && Number(d.proc_capacity) > 0)) bad('proc_capacity', 'Enter a whole number, or leave it blank.');
      }
      if (d.weight_lbs && !(Number(d.weight_lbs) > 0 && Number(d.weight_lbs) <= 5000)) bad('weight', 'Enter a weight between 1 and 5,000 lb, or leave it blank.');
      if (d.age_value && !(Number(d.age_value) >= 0 && Number.isInteger(Number(d.age_value)))) bad('age', 'Enter a whole number, or leave it blank.');
      if (d.age_value && Number(d.age_value) * (d.age_unit === 'years' ? 12 : 1) > 600) bad('age', 'That age looks too high. Check the number and the unit.');
      if (d.website_url && !/^https?:\/\//i.test(d.website_url.trim())) bad('website', 'Start the website with https://');
      if ((d.description || '').trim().length < 10) bad('description', 'Add a few lines buyers will want to know.');
    }
    if (name === 'photos') {
      if (S.processing) { showError('Hang on, your photos are still getting ready.'); return false; }
      if (!S.photos.length) { showError('Add at least one photo. Listings with photos get far more calls.'); return false; }
    }
    if (name === 'price') {
      if (k !== 'business' && k !== 'processor' && !d.call && !(Number(d.price) > 0)) bad('price', 'Enter a price, or check Call for price.');
      if (k === 'beef') {
        if (!(d.farm_delivery || []).length) bad('farm_delivery', 'Pick at least one: pickup, delivery or shipping.');
        if (d.farm_deposit_amount !== '' && !(Number(d.farm_deposit_amount) > 0)) bad('farm_deposit_amount', 'Enter a dollar amount, or leave it blank.');
      }
      if (!d.city || !d.state) { ok = false; const e = $('lf-e-place'); if (e) e.textContent = 'Enter your ZIP, or your town and state.'; if (!S.editPlace && !d.place_ok) { S.editPlace = true; $('lf-place').innerHTML = placeHtml(); wirePlace(); } }
      if (d.zip && d.zip.length !== 5) bad('zip', 'A ZIP code is 5 digits. Or clear it and enter your town and state.');
      if (d.contact_pref !== 'message' && !phoneDigits(d.phone)) bad('phone', 'Enter a 10-digit phone number, or pick Message me on Herd Hub.');
    }
    if (!ok) showError('Fix the highlighted fields to keep going.');
    return ok;
  }

  function showError(msg) { const e = $('lf-error'); e.textContent = msg; e.hidden = false; }
  function hideError() { const e = $('lf-error'); if (e) { e.hidden = true; e.textContent = ''; } }

  // ── Submit ───────────────────────────────────────────────
  function fieldsPayload() {
    const d = S.data, k = kindOf(d.category);
    const age = d.age_value === '' ? '' : String(Number(d.age_value) * (d.age_unit === 'years' ? 12 : 1));
    const p = {
      category: d.category, title: d.title.trim(), description: d.description.trim(),
      breed: (k === 'livestock' || k === 'genetics' || k === 'dog') ? d.breed : '',
      quantity: NO_QTY.includes(k) ? '1' : String(parseInt(d.quantity) || 1),
      weight_lbs: k === 'livestock' ? d.weight_lbs : '', age_months: (k === 'livestock' || k === 'dog') ? age : '',
      sex: k === 'livestock' ? (AUTO_SEX[d.category] || d.sex || '') : '',
      price: (k === 'business' || k === 'processor' || d.call) ? '' : d.price,
      price_type: (k === 'business' || k === 'processor') ? 'fixed' : d.call ? 'call' : (d.price_type || 'fixed'),
      zip: d.zip || '', city: d.city.trim(), state: d.state, contact_pref: d.contact_pref,
      website_url: ['business', 'beef', 'processor'].includes(k) ? (d.website_url || '').trim() : '',
    };
    const list = key => JSON.stringify(d[key] || []);
    if (k === 'beef') Object.assign(p, {
      farm_name: (d.farm_name || '').trim(), farm_proteins: list('farm_proteins'), farm_product_forms: list('farm_product_forms'),
      farm_production_methods: list('farm_production_methods'), farm_processing: list('farm_processing'), farm_delivery: list('farm_delivery'),
      farm_availability: d.farm_availability || '', farm_harvest_date: d.farm_harvest_date || '', farm_deposit_amount: d.farm_deposit_amount || '',
    });
    if (k === 'processor') Object.assign(p, {
      proc_inspection: list('proc_inspection'), proc_species: list('proc_species'), proc_services: list('proc_services'),
      proc_lead_weeks: d.proc_lead_weeks === '' ? '' : String(d.proc_lead_weeks), proc_capacity: d.proc_capacity === '' ? '' : String(d.proc_capacity),
      proc_haul: d.proc_haul ? 'true' : 'false',
    });
    return p;
  }

  // US numbers: 10 digits, a leading 1 dropped. Returns '' when it isn't one.
  function phoneDigits(v) {
    let x = String(v || '').replace(/\D/g, '');
    if (x.length === 11 && x[0] === '1') x = x.slice(1);
    return x.length === 10 && !/^[01]/.test(x) && !/^.{3}[01]/.test(x) ? x : '';
  }
  // Saves the phone to the account first when the seller picked call or text
  // and typed a new one. Returns false (with the error shown) if it fails.
  async function savePhoneIfNeeded() {
    const d = S.data;
    if (d.contact_pref === 'message') return true;
    if (phoneDigits(d.phone) === phoneDigits(me().phone)) return true;
    try {
      const r = await fetch(`${API}/api/auth/me/phone`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: d.phone }) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) { showError(res.error || 'Could not save your phone number. Please try again.'); return false; }
      if (typeof currentUser !== 'undefined' && currentUser) currentUser.phone = res.phone;
      d.phone = res.phone;
      return true;
    } catch (e) { showError('Connection problem. Check your signal and try again. Nothing was lost.'); return false; }
  }

  async function submitNew() {
    const d = S.data;
    const limit = (PLANS[d.tier] || PLANS.burger).photos;
    const fd = new FormData();
    Object.entries(fieldsPayload()).forEach(([k, v]) => fd.append(k, v));
    fd.append('tier', d.tier);
    S.photos.slice(0, limit).forEach((p, i) => fd.append('photos', p.blob, `photo-${i + 1}.jpg`));
    busy(true, 'Posting your listing…');
    if (!(await savePhoneIfNeeded())) { busy(false); return; }
    try {
      const r = await fetch(`${API}/api/listings`, { method: 'POST', headers: authHeaders(), body: fd });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 403 && res.code === 'EMAIL_NOT_VERIFIED') { closeForm(); showVerifyGateModal(); return; }
        if (res.code === 'FEATURED_LIMIT') { await loadFeaturedTrial(); S.step = steps().indexOf('plan'); render(); }
        showError(res.error || 'Could not post your listing. Please try again.'); return;
      }
      clearDraft();
      if (window._trackEvent) { try { window._trackEvent('listings', 'post_listing', 'success'); } catch (e) {} }
      const msg = res.awaiting_approval
        ? "Saved. Prime and Choice spots are reviewed by hand while we launch. It goes live as soon as it's approved, and your free 30 days start then."
        : res.launch_trial ? 'Posted. Your free featured run lasts 30 days, then it stays up as a regular listing.' : 'Your listing is live.';
      closeForm();
      showToast(msg);
      try { loadHomepageSections(); loadRecentListings(); } catch (e) {}
      if (res.show_beef_box_offer && !localStorage.getItem('beef_box_dismissed')) { showBeefBoxOffer(res.lister_number, res.id); return; }
      showPage('account'); switchAcctTab('listings');
    } catch (e) {
      showError('Connection problem. Check your signal and tap Post Listing again. Nothing was lost.');
    } finally { busy(false); }
  }

  async function submitEdit() {
    const id = S.id;
    busy(true, 'Saving…');
    if (!(await savePhoneIfNeeded())) { busy(false); return; }
    try {
      const r = await fetch(`${API}/api/listings/${id}`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(fieldsPayload()) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) { showError(res.error || 'Could not save your changes. Please try again.'); return; }
      const problems = [];
      for (const pid of S.removed) {
        const rr = await fetch(`${API}/api/listings/${id}/photos/${pid}`, { method: 'DELETE', headers: authHeaders() });
        if (!rr.ok) problems.push('a photo could not be removed');
      }
      S.removed = [];
      const fresh = S.photos.filter(p => p.kind === 'new');
      if (fresh.length) {
        const fd = new FormData();
        fresh.forEach((p, i) => fd.append('photos', p.blob, `photo-${i + 1}.jpg`));
        const rp = await fetch(`${API}/api/listings/${id}/photos`, { method: 'POST', headers: authHeaders(), body: fd });
        const dp = await rp.json().catch(() => ({}));
        if (!rp.ok) problems.push(dp.error || 'new photos could not be added');
        else (dp.ids || []).forEach((newId, i) => { if (fresh[i]) { fresh[i].kind = 'old'; fresh[i].id = Number(newId); } });
      }
      const ids = S.photos.filter(p => p.kind === 'old').map(p => p.id);
      const origOrder = (S.original.photos || []).map(p => Number(p.id));
      if (ids.length && (fresh.length || ids.join() !== origOrder.filter(x => ids.includes(x)).join())) {
        const ro = await fetch(`${API}/api/listings/${id}/photos/order`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
        if (!ro.ok) problems.push('the photo order could not be saved');
      }
      closeForm();
      showToast(problems.length ? `Saved, but ${problems.join(' and ')}. Open Edit to try again.` : 'Your changes are saved.');
      try { loadMyListings(); loadHomepageSections(); } catch (e) {}
    } catch (e) {
      showError('Connection problem. Check your signal and tap Save Changes again.');
    } finally { busy(false); }
  }

  function busy(on, label) {
    S.busy = on;
    const n = $('lf-next'), b = $('lf-back');
    n.disabled = on; b.disabled = on;
    if (on) { n.dataset.label = n.textContent; n.textContent = label; }
    else if (n.dataset.label) { n.textContent = n.dataset.label; delete n.dataset.label; }
  }

  // ── Navigation ───────────────────────────────────────────
  document.addEventListener('click', e => {
    if (!S) return;
    if (e.target.id === 'lf-back') { if (S.step > 0) { S.step--; render(); } }
    if (e.target.id === 'lf-next') {
      if (S.busy) return;
      const st = steps(), name = st[S.step];
      if (name === 'review') {
        for (const s of ['details', 'photos', 'price']) {
          if (!quickCheck(s)) { S.step = st.indexOf(s); render(); check(s); return; }
        }
        S.mode === 'edit' ? submitEdit() : submitNew();
        return;
      }
      if (!check(name)) return;
      S.step++; saveDraft(); render();
    }
  });
  // Checks without touching the page (used before submit, after jumping around)
  function quickCheck(name) {
    const d = S.data, k = kindOf(d.category);
    const has = key => (d[key] || []).length > 0;
    if (name === 'details') return (d.title || '').trim().length >= 5 && (d.description || '').trim().length >= 10 && (NO_QTY.includes(k) || parseInt(d.quantity) >= 1)
      && (k !== 'beef' || (has('farm_proteins') && has('farm_product_forms')))
      && (k !== 'processor' || (has('proc_inspection') && has('proc_species') && has('proc_services')));
    if (name === 'photos') return S.photos.length > 0 && !S.processing;
    if (name === 'price') return (k === 'business' || k === 'processor' || d.call || Number(d.price) > 0) && !!d.city && !!d.state && (d.contact_pref === 'message' || !!phoneDigits(d.phone))
      && (k !== 'beef' || has('farm_delivery'));
    return true;
  }
})();
