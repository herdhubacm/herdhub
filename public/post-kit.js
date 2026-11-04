/**
 * HERD HUB — Post kit (share to social)
 * Caption and card text for the admin "Post this listing" action.
 * Pure functions, no DOM. Loaded by admin.html; also require()-able for tests.
 *
 * Rules (Job - Listing and Steakholder Posts): the caption is in the seller's
 * favor, in a cattleman's voice: what it is, where, the number that matters,
 * one line of why (the seller's own words), then "Listed free on Herd Hub"
 * with the link (Facebook) or "link in bio" (Instagram / TikTok). Never add
 * a claim the seller didn't make. Hashtags after the caption, 8 to 12.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PostKit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATE_NAMES = {
    AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California', CO:'Colorado', CT:'Connecticut', DE:'Delaware',
    FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky',
    LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri',
    MT:'Montana', NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York',
    NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island',
    SC:'South Carolina', SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia',
    WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming',
  };

  function fmtCat(cat) {
    return String(cat || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function fmtPrice(price, type) {
    if (type === 'call' || price === null || price === undefined || price === '') return 'Contact for price';
    const n = Number(price);
    if (!Number.isFinite(n)) return 'Contact for price';
    const cents = n % 1 !== 0;
    const dollars = '$' + n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    switch (type) {
      case 'per_head':   return `${dollars}/head`;
      case 'per_lb':     return `${dollars}/lb`;
      case 'per_cwt':    return `${dollars}/cwt`;
      case 'negotiable': return `${dollars} (negotiable)`;
      case 'obo':        return `${dollars} OBO`;
      default:           return dollars;
    }
  }

  // The seller's own first sentence, trimmed. Their claim, not ours.
  function firstSentence(text, max) {
    max = max || 160;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = t.match(/^.*?[.!?](?=\s|$)/);
    let s = (m ? m[0] : t).trim();
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
    return s;
  }

  function handleFrom(url) {
    if (!url) return '';
    const m = String(url).match(/(?:facebook\.com|instagram\.com|tiktok\.com)\/@?([A-Za-z0-9_.]+)/i);
    if (!m) return '';
    const h = m[1].replace(/\.$/, '');
    if (/^(profile\.php|pages|people|p|reel|share)$/i.test(h)) return '';
    return '@' + h;
  }

  function sellerLine(kit, handleOverride) {
    const typed = String(handleOverride || '').trim();
    const h = typed || handleFrom(kit.seller_instagram || kit.ranch_instagram) || handleFrom(kit.seller_facebook || kit.ranch_facebook);
    if (h) return `Seller: ${h.startsWith('@') ? h : '@' + h}`;
    const op = kit.ranch_name || kit.seller_name;
    return op ? `Listed by ${op}` : '';
  }

  function tag(s) {
    return '#' + String(s || '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, '');
  }

  function hashtagsFor(kit) {
    const out = ['#HerdHub', '#CattleForSale'];
    const cat = fmtCat(kit.category);
    if (cat) out.push(tag(cat));
    if (kit.breed) { out.push(tag(kit.breed)); if (cat) out.push(tag(kit.breed + ' ' + cat)); }
    const st = STATE_NAMES[kit.state];
    if (st) out.push(tag(st + ' Cattle'), tag(st + ' Ranch'));
    out.push('#Ranching', '#Cattlemen', '#BuyDirect', '#AmericanRancher', '#RanchLife');
    return Array.from(new Set(out.filter(t => t.length > 1))).slice(0, 12);
  }

  function factsLine(kit) {
    const where = [kit.city, kit.state].filter(Boolean).join(', ');
    return [kit.breed, fmtCat(kit.category), where, fmtPrice(kit.price, kit.price_type)].filter(Boolean).join(' · ');
  }

  function buildCaptions(kit, opts) {
    opts = opts || {};
    const base = [String(kit.title || '').trim(), factsLine(kit), firstSentence(kit.description)].filter(Boolean);
    const seller = sellerLine(kit, opts.handle);
    const tags = hashtagsFor(kit).join(' ');
    const facebook  = base.concat([`Listed free on Herd Hub: https://theherdhub.com/listing/${kit.id}`, seller]).filter(Boolean).join('\n') + '\n\n' + tags;
    const instagram = base.concat(['Listed free on Herd Hub. Link in bio.', seller]).filter(Boolean).join('\n') + '\n\n' + tags;
    return { facebook, instagram, hashtags: tags };
  }

  function cardText(kit) {
    const where = [kit.city, kit.state].filter(Boolean).join(', ');
    return {
      kicker: 'LISTED FREE ON HERD HUB',
      headline: [fmtCat(kit.category), where].filter(Boolean).join(' · '),
      price: fmtPrice(kit.price, kit.price_type),
      url: `theherdhub.com/listing/${kit.id}`,
    };
  }

  return { STATE_NAMES, fmtCat, fmtPrice, firstSentence, handleFrom, sellerLine, hashtagsFor, factsLine, buildCaptions, cardText };
});
