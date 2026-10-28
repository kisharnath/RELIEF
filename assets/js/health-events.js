/**
 * Relief - community health events (health camps, vaccination drives,
 * screening events and outreach programmes) for rural users.
 *
 * Two kinds of record share one shape:
 *   - confirmed events: checked by a moderator (status 'confirmed')
 *   - organiser submissions: anything else. A submission is ALWAYS created with
 *     status 'pending' (shown as "Unverified") whatever the input says, and only
 *     decide() can turn it into 'confirmed', with a named moderator and evidence.
 *     Records that are 'rejected' are never shown to the public.
 *
 * Times: every event is stored as an ISO 8601 string with an offset. The form
 * takes a date and a time in India Standard Time (UTC+05:30, no daylight saving)
 * so the same input gives the same instant on every device.
 *
 * Where the data lives (same rules as facility corrections, see
 * docs/HEALTH_EVENTS.md):
 *   - ReliefAPI (the backend) when it is reachable. Moderator permissions and rate
 *     limits can only really be enforced there.
 *   - A browser-only demo queue (localStorage), only in demo mode (localhost,
 *     file://, or an explicit flag) and only when the backend cannot be reached.
 *     Demo records are marked demo: true and are never sent anywhere.
 *
 * Pure functions plus a store that takes its dependencies, so it runs in node:test.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.HealthEvents = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEMO_QUEUE_KEY = 'relief_demo_health_events';
  var SUBMISSION_LOG_KEY = 'relief_health_event_submissions';

  var IST_OFFSET = '+05:30';
  var MINUTE = 60 * 1000;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  var STATUSES = ['pending', 'confirmed', 'rejected'];

  var TYPES = {
    'health-camp': 'Health camp',
    'vaccination': 'Vaccination drive',
    'screening': 'Screening event',
    'outreach': 'Outreach programme'
  };

  var LIMITS = {
    minTitle: 5,
    maxTitle: 120,
    minPlace: 2,
    maxPlace: 80,
    minVenue: 5,
    maxVenue: 200,
    minOrganiser: 3,
    maxOrganiser: 120,
    maxServices: 12,
    maxServiceLength: 60,
    minEligibility: 3,
    maxEligibility: 300,
    maxEmail: 100,
    maxSourceUrl: 300,
    maxActor: 60,
    maxNote: 500,
    minReason: 5,
    minEvidence: 10,
    maxDurationMs: 14 * DAY,
    maxLeadMs: 365 * DAY,
    minIntervalMs: 30 * 1000,
    maxPerDay: 5,
    duplicateWindowMs: 7 * DAY,
    maxDemoPending: 100
  };

  // An event with no end time is treated as finished this long after it starts.
  var DEFAULT_DURATION_MS = 8 * HOUR;

  // ---- text ---------------------------------------------------------------

  // Removes HTML tags, control characters, invisible direction/zero-width marks and
  // stray angle brackets, and collapses whitespace. Output is still escaped wherever it is shown.
  function sanitizeText(value, max) {
    var text = String(value === null || value === undefined ? '' : value)
      .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, ' ')
      .replace(/<\/?[a-zA-Z!][^>]*>/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (typeof max === 'number' && text.length > max) text = text.slice(0, max).trim();
    return text;
  }

  function parseServices(value) {
    var parts = Array.isArray(value) ? value : String(value === null || value === undefined ? '' : value).split(/[,;\n]/);
    var seen = {};
    var out = [];
    parts.forEach(function (part) {
      var item = sanitizeText(part, LIMITS.maxServiceLength);
      var key = item.toLowerCase();
      if (item && !seen[key]) {
        seen[key] = true;
        out.push(item);
      }
    });
    return out;
  }

  function digitCount(text) {
    return (String(text).match(/\d/g) || []).length;
  }

  function isPhone(text) {
    return /^[+\d][\d\s\-().]*$/.test(text) && digitCount(text) >= 7 && digitCount(text) <= 15;
  }

  function isEmail(text) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }

  function cleanSourceUrl(raw) {
    var text = sanitizeText(raw, LIMITS.maxSourceUrl + 1);
    if (!text) return { value: '' };
    if (text.length > LIMITS.maxSourceUrl) return { error: 'The link is too long.' };
    var url;
    try {
      url = new URL(text);
    } catch (e) {
      return { error: 'Enter a full web address starting with http:// or https://.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Enter a full web address starting with http:// or https://.' };
    if (url.username || url.password) return { error: 'Remove the user name or password from the link.' };
    if (url.hostname.indexOf('.') === -1) return { error: 'That web address does not look right.' };
    return { value: url.href };
  }

  // ---- dates and times ----------------------------------------------------

  // 'YYYY-MM-DD' that is a real calendar date (no 31 April, no 29 February in 2027).
  function isValidDate(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    if (!m) return false;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
    var days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= days[mo - 1];
  }

  // 'HH:MM', 24 hour clock.
  function isValidTime(text) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(text || ''));
  }

  // Date + time in India Standard Time to an ISO string, or null when either is invalid.
  function toIstIso(date, time) {
    if (!isValidDate(date) || !isValidTime(time)) return null;
    return date + 'T' + time + ':00' + IST_OFFSET;
  }

  // Only full ISO 8601 date-times with an explicit offset or Z are accepted, so a
  // record never changes meaning with the reader's time zone.
  function parseInstant(value) {
    if (typeof value !== 'string') return NaN;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
    if (!isValidDate(value.slice(0, 10))) return NaN;
    return Date.parse(value);
  }

  // Midnight at the start of an IST calendar day, as a timestamp.
  function istDayStart(date) {
    return isValidDate(date) ? Date.parse(date + 'T00:00:00' + IST_OFFSET) : NaN;
  }

  // The IST calendar date ('YYYY-MM-DD') of a timestamp.
  function istDate(ms) {
    var shifted = new Date(ms + 330 * MINUTE);
    return shifted.toISOString().slice(0, 10);
  }

  function endOf(event) {
    var end = parseInstant(event && event.endsAt);
    if (isFinite(end)) return end;
    var start = parseInstant(event && event.startsAt);
    return isFinite(start) ? start + DEFAULT_DURATION_MS : NaN;
  }

  /**
   * 'upcoming' | 'ongoing' | 'past'. An event is past once its end time (or
   * start + 8 hours when no end is given) is behind us.
   */
  function timeState(event, now) {
    var t = typeof now === 'number' ? now : Date.now();
    var start = parseInstant(event && event.startsAt);
    var end = endOf(event);
    if (!isFinite(start)) return 'past';
    if (end <= t) return 'past';
    if (start <= t) return 'ongoing';
    return 'upcoming';
  }

  // ---- records ------------------------------------------------------------

  function copyRecord(record) {
    return Object.assign({}, record, {
      services: Array.isArray(record.services) ? record.services.slice() : [],
      history: Array.isArray(record.history) ? record.history.map(function (h) { return Object.assign({}, h); }) : []
    });
  }

  /**
   * Cleans one event record from the data file, the backend or the demo queue.
   * Returns null when it cannot be shown safely (no id, title or valid start,
   * or an end before the start). The status is 'confirmed' only when the record
   * says exactly that; anything unknown becomes 'pending' (unverified).
   */
  function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = sanitizeText(raw.id, 80);
    var title = sanitizeText(raw.title, LIMITS.maxTitle);
    var start = parseInstant(raw.startsAt);
    if (!id || !title || !isFinite(start)) return null;
    var end = parseInstant(raw.endsAt);
    if (raw.endsAt !== undefined && raw.endsAt !== null && raw.endsAt !== '') {
      if (!isFinite(end) || end <= start) return null;
    }
    var status = raw.status === 'confirmed' || raw.status === 'rejected' ? raw.status : 'pending';
    var updated = parseInstant(raw.lastUpdated);
    var phone = sanitizeText(raw.contactPhone, 30);
    var email = sanitizeText(raw.contactEmail, LIMITS.maxEmail);
    var source = cleanSourceUrl(raw.sourceUrl);
    return {
      id: id,
      title: title,
      type: Object.prototype.hasOwnProperty.call(TYPES, raw.type) ? raw.type : 'outreach',
      startsAt: raw.startsAt,
      endsAt: isFinite(end) ? raw.endsAt : null,
      district: sanitizeText(raw.district, LIMITS.maxPlace),
      venue: sanitizeText(raw.venue, LIMITS.maxVenue),
      organiser: sanitizeText(raw.organiser, LIMITS.maxOrganiser),
      services: parseServices(raw.services).slice(0, LIMITS.maxServices),
      eligibility: sanitizeText(raw.eligibility, LIMITS.maxEligibility),
      contactPhone: phone && isPhone(phone) ? phone : '',
      contactEmail: email && isEmail(email) ? email : '',
      sourceUrl: source.value || '',
      status: status,
      lastUpdated: isFinite(updated) ? raw.lastUpdated : null,
      verifiedBy: status === 'confirmed' ? sanitizeText(raw.verifiedBy, LIMITS.maxActor) || null : null,
      sample: raw.sample === true,
      demo: raw.demo === true
    };
  }

  function normalizeEvents(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var e = normalizeEvent(raw);
      if (e && !seen[e.id]) {
        seen[e.id] = true;
        out.push(e);
      }
    });
    return out;
  }

  function isConfirmed(event) {
    return !!event && event.status === 'confirmed';
  }

  // ---- filtering ----------------------------------------------------------

  /**
   * Checks the date filter before it is used. from / to: 'YYYY-MM-DD' or ''.
   * Returns { valid, errors, fromMs, toMs } where toMs is the end of the "to" day.
   */
  function validateFilters(filters) {
    var f = filters || {};
    var errors = {};
    var fromMs = null;
    var toMs = null;
    if (f.from) {
      if (!isValidDate(f.from)) errors.from = 'Enter a valid "from" date.';
      else fromMs = istDayStart(f.from);
    }
    if (f.to) {
      if (!isValidDate(f.to)) errors.to = 'Enter a valid "to" date.';
      else toMs = istDayStart(f.to) + DAY;
    }
    if (fromMs !== null && toMs !== null && toMs <= fromMs) {
      errors.to = 'The "to" date must be on or after the "from" date.';
    }
    return { valid: Object.keys(errors).length === 0, errors: errors, fromMs: fromMs, toMs: toMs };
  }

  function lower(text) {
    return String(text || '').toLowerCase();
  }

  /**
   * filters: { from, to, location, type, includeUnverified }
   *   - a date range keeps events that overlap it (a 3 day camp that started
   *     yesterday still shows for "today")
   *   - location matches district, venue or title, ignoring case
   *   - unverified submissions are left out unless includeUnverified is true
   *   - rejected records are always left out
   * Invalid date filters are ignored here; check them with validateFilters first.
   */
  function filterEvents(events, filters) {
    var f = filters || {};
    var range = validateFilters(f);
    var location = lower(sanitizeText(f.location, LIMITS.maxPlace));
    var type = Object.prototype.hasOwnProperty.call(TYPES, f.type) ? f.type : '';
    return (Array.isArray(events) ? events : []).filter(function (e) {
      if (!e || e.status === 'rejected') return false;
      if (!isConfirmed(e) && f.includeUnverified !== true) return false;
      if (type && e.type !== type) return false;
      if (location) {
        var haystack = lower(e.district) + ' ' + lower(e.venue) + ' ' + lower(e.title);
        if (haystack.indexOf(location) === -1) return false;
      }
      if (range.valid) {
        var start = parseInstant(e.startsAt);
        var end = endOf(e);
        if (range.fromMs !== null && end <= range.fromMs) return false;
        if (range.toMs !== null && start >= range.toMs) return false;
      }
      return true;
    });
  }

  /**
   * Splits events into { current, past }. Current (ongoing and upcoming) are
   * soonest first; past are most recent first, so they can be shown as an archive.
   */
  function partitionByTime(events, now) {
    var t = typeof now === 'number' ? now : Date.now();
    var current = [];
    var past = [];
    (Array.isArray(events) ? events : []).forEach(function (e) {
      (timeState(e, t) === 'past' ? past : current).push(e);
    });
    current.sort(function (a, b) { return parseInstant(a.startsAt) - parseInstant(b.startsAt); });
    past.sort(function (a, b) { return endOf(b) - endOf(a); });
    return { current: current, past: past };
  }

  function districts(events) {
    var seen = {};
    var out = [];
    (Array.isArray(events) ? events : []).forEach(function (e) {
      var name = e && e.district;
      if (name && !seen[name.toLowerCase()]) {
        seen[name.toLowerCase()] = true;
        out.push(name);
      }
    });
    return out.sort();
  }

  // ---- organiser submissions ----------------------------------------------

  /**
   * input: { title, type, startDate, startTime, endDate, endTime, district, venue,
   *          organiser, services, eligibility, contactPhone, contactEmail, sourceUrl, website }
   * ctx:   { now }
   * Returns { valid, errors, clean }. `website` is a hidden honeypot field.
   * Any `status`, `verifiedBy` or `lastUpdated` in the input is ignored.
   */
  function validateSubmission(input, ctx) {
    var data = input || {};
    var now = ctx && typeof ctx.now === 'number' ? ctx.now : Date.now();
    var errors = {};
    var clean = {};

    if (data.website !== undefined && data.website !== null && String(data.website).trim() !== '') {
      return { valid: false, errors: { form: 'This could not be submitted.' }, clean: {}, spam: true };
    }

    var title = sanitizeText(data.title);
    if (title.length < LIMITS.minTitle) errors.title = 'Enter the event name (at least ' + LIMITS.minTitle + ' characters).';
    else if (title.length > LIMITS.maxTitle) errors.title = 'Keep the event name under ' + LIMITS.maxTitle + ' characters.';
    else clean.title = title;

    if (!Object.prototype.hasOwnProperty.call(TYPES, data.type)) errors.type = 'Choose the kind of event.';
    else clean.type = data.type;

    // Date and time.
    var startDate = String(data.startDate || '').trim();
    var startTime = String(data.startTime || '').trim();
    var endDate = String(data.endDate || '').trim() || startDate;
    var endTime = String(data.endTime || '').trim();
    if (!startDate) errors.startDate = 'Enter the date of the event.';
    else if (!isValidDate(startDate)) errors.startDate = 'Enter a real date, for example 2026-11-14.';
    if (!startTime) errors.startTime = 'Enter the start time.';
    else if (!isValidTime(startTime)) errors.startTime = 'Enter the start time as hours and minutes, for example 09:30.';
    if (data.endDate && !isValidDate(endDate)) errors.endDate = 'Enter a real end date, or leave it empty for a one day event.';
    if (!endTime) errors.endTime = 'Enter the end time.';
    else if (!isValidTime(endTime)) errors.endTime = 'Enter the end time as hours and minutes, for example 16:00.';

    var startsAt = toIstIso(startDate, startTime);
    var endsAt = toIstIso(endDate, endTime);
    if (startsAt && !errors.startDate && !errors.startTime) {
      var start = Date.parse(startsAt);
      if (start <= now) errors.startDate = 'The event must start in the future.';
      else if (start - now > LIMITS.maxLeadMs) errors.startDate = 'Events can be listed up to one year ahead.';
      else clean.startsAt = startsAt;
    }
    if (clean.startsAt && endsAt && !errors.endDate && !errors.endTime) {
      var duration = Date.parse(endsAt) - Date.parse(clean.startsAt);
      if (duration <= 0) errors.endTime = 'The event must end after it starts.';
      else if (duration > LIMITS.maxDurationMs) errors.endDate = 'An event can last at most 14 days. Submit longer programmes as separate events.';
      else clean.endsAt = endsAt;
    }

    var district = sanitizeText(data.district);
    if (district.length < LIMITS.minPlace) errors.district = 'Enter the district or block.';
    else if (district.length > LIMITS.maxPlace) errors.district = 'Keep the district under ' + LIMITS.maxPlace + ' characters.';
    else clean.district = district;

    var venue = sanitizeText(data.venue);
    if (venue.length < LIMITS.minVenue) errors.venue = 'Enter the venue: village, landmark or building (at least ' + LIMITS.minVenue + ' characters).';
    else if (venue.length > LIMITS.maxVenue) errors.venue = 'Keep the venue under ' + LIMITS.maxVenue + ' characters.';
    else clean.venue = venue;

    var organiser = sanitizeText(data.organiser);
    if (organiser.length < LIMITS.minOrganiser) errors.organiser = 'Enter who is running the event.';
    else if (organiser.length > LIMITS.maxOrganiser) errors.organiser = 'Keep the organiser name under ' + LIMITS.maxOrganiser + ' characters.';
    else clean.organiser = organiser;

    var services = parseServices(data.services);
    if (services.length === 0) errors.services = 'List at least one service. Separate several with commas.';
    else if (services.length > LIMITS.maxServices) errors.services = 'List at most ' + LIMITS.maxServices + ' services.';
    else clean.services = services;

    var eligibility = sanitizeText(data.eligibility);
    if (eligibility.length < LIMITS.minEligibility) errors.eligibility = 'Say who can attend, for example "Everyone" or "Children under 5".';
    else if (eligibility.length > LIMITS.maxEligibility) errors.eligibility = 'Keep eligibility under ' + LIMITS.maxEligibility + ' characters.';
    else clean.eligibility = eligibility;

    var phone = sanitizeText(data.contactPhone, 31);
    var email = sanitizeText(data.contactEmail, LIMITS.maxEmail + 1);
    if (phone && !isPhone(phone)) errors.contactPhone = 'Enter a phone number using digits, spaces, +, - and brackets (7 to 15 digits).';
    if (email && (email.length > LIMITS.maxEmail || !isEmail(email))) errors.contactEmail = 'Enter a valid email address.';
    if (!phone && !email) errors.contactPhone = 'Give a phone number or email so people can check before travelling.';
    if (!errors.contactPhone) clean.contactPhone = phone;
    if (!errors.contactEmail) clean.contactEmail = email;

    var source = cleanSourceUrl(data.sourceUrl);
    if (source.error) errors.sourceUrl = source.error; else clean.sourceUrl = source.value;

    return { valid: Object.keys(errors).length === 0, errors: errors, clean: clean };
  }

  // Same title, start and district (ignoring case and spacing) gives the same fingerprint.
  function fingerprint(clean) {
    return [lower(clean.title).replace(/\s+/g, ' '), clean.startsAt, lower(clean.district)].join('::');
  }

  /**
   * log: [{ at: ms, fingerprint }] of this browser's earlier submissions.
   * Client-side only: slows down double clicks and loops, not a determined person.
   */
  function checkRateLimit(log, now, clean, limits) {
    var lim = Object.assign({}, LIMITS, limits || {});
    var entries = (Array.isArray(log) ? log : []).filter(function (e) {
      return e && typeof e.at === 'number' && isFinite(e.at) && e.at <= now + MINUTE;
    });
    var fp = clean ? fingerprint(clean) : null;
    if (fp && entries.some(function (e) { return e.fingerprint === fp && now - e.at < lim.duplicateWindowMs; })) {
      return { allowed: false, reason: 'duplicate', message: 'You already submitted this event. A moderator will check it.' };
    }
    var last = entries.reduce(function (max, e) { return Math.max(max, e.at); }, 0);
    if (last && now - last < lim.minIntervalMs) {
      return { allowed: false, reason: 'too-fast', message: 'Please wait a few seconds before submitting another event.' };
    }
    if (entries.filter(function (e) { return now - e.at < DAY; }).length >= lim.maxPerDay) {
      return { allowed: false, reason: 'daily', message: 'That is the limit for today. Please try again tomorrow.' };
    }
    return { allowed: true, reason: null, message: '' };
  }

  /**
   * Makes a submission from validated input. Its status is always 'pending',
   * so it can never be published as confirmed without a moderator.
   */
  function buildSubmission(clean, ctx) {
    var c = ctx || {};
    var now = typeof c.now === 'number' ? c.now : Date.now();
    var at = new Date(now).toISOString();
    return {
      id: c.id || ('evt_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
      title: clean.title,
      type: clean.type,
      startsAt: clean.startsAt,
      endsAt: clean.endsAt,
      district: clean.district,
      venue: clean.venue,
      organiser: clean.organiser,
      services: clean.services.slice(),
      eligibility: clean.eligibility,
      contactPhone: clean.contactPhone || '',
      contactEmail: clean.contactEmail || '',
      sourceUrl: clean.sourceUrl || '',
      status: 'pending',
      createdAt: at,
      lastUpdated: at,
      decidedAt: null,
      verifiedBy: null,
      decisionReason: null,
      evidence: null,
      history: [{ seq: 1, at: at, action: 'submitted', by: 'organiser', note: '', evidence: '' }]
    };
  }

  // ---- moderation ---------------------------------------------------------

  /**
   * The only way a submission changes status. Returns { ok, record, errors } and
   * never edits the record it is given.
   *   - only a pending submission can be decided; a decision is final
   *   - the moderator is named; approving needs evidence, rejecting a reason
   *   - lastUpdated moves to the decision time and a history entry is appended
   * decision: { decision: 'approve' | 'reject', actor, reason, evidence }
   */
  function decide(record, decision, ctx) {
    var d = decision || {};
    var errors = {};
    if (!record || typeof record !== 'object' || STATUSES.indexOf(record.status) === -1) {
      return { ok: false, record: null, errors: { form: 'That submission could not be found.' } };
    }
    if (record.status !== 'pending') {
      return { ok: false, record: null, errors: { form: 'This submission was already ' + record.status + '. A decision cannot be changed.' } };
    }
    var kind = d.decision;
    if (kind !== 'approve' && kind !== 'reject') errors.decision = 'Choose approve or reject.';
    var actor = sanitizeText(d.actor, LIMITS.maxActor);
    if (actor.length < 2) errors.actor = 'Enter your name so the decision is logged.';
    var reason = sanitizeText(d.reason, LIMITS.maxNote);
    var evidence = sanitizeText(d.evidence, LIMITS.maxNote);
    if (kind === 'approve' && evidence.length < LIMITS.minEvidence) {
      errors.evidence = 'Confirming needs evidence: say how you checked the event with the organiser (at least ' + LIMITS.minEvidence + ' characters).';
    }
    if (kind === 'reject' && reason.length < LIMITS.minReason) {
      errors.reason = 'Rejecting needs a reason (at least ' + LIMITS.minReason + ' characters).';
    }
    if (Object.keys(errors).length) return { ok: false, record: null, errors: errors };

    var c = ctx || {};
    var now = typeof c.now === 'number' ? c.now : Date.now();
    var at = new Date(now).toISOString();
    var next = copyRecord(record);
    var action = kind === 'approve' ? 'confirmed' : 'rejected';
    next.status = action;
    next.decidedAt = at;
    next.lastUpdated = at;
    next.verifiedBy = kind === 'approve' ? actor : null;
    next.decisionReason = reason || null;
    next.evidence = evidence || null;
    next.history.push({ seq: next.history.length + 1, at: at, action: action, by: actor, note: reason, evidence: evidence });
    return { ok: true, record: next, errors: {} };
  }

  // ---- store --------------------------------------------------------------

  var UNAVAILABLE_MESSAGE = 'Events cannot be sent right now because the review service is not reachable. Please try again later.';

  function readJson(storage, key, fallback) {
    try {
      var parsed = JSON.parse(storage.getItem(key));
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * deps: { api, storage, demo (boolean), now (fn), idFn (fn), limits }
   * Every method resolves to { ok, ... } and never rejects.
   */
  function createStore(deps) {
    var d = deps || {};
    var api = d.api || null;
    var storage = d.storage || null;
    var demo = d.demo === true;
    var clock = typeof d.now === 'function' ? d.now : function () { return Date.now(); };

    function hasApi(method) { return !!(api && typeof api[method] === 'function'); }

    function readQueue() {
      var data = storage ? readJson(storage, DEMO_QUEUE_KEY, []) : [];
      return Array.isArray(data) ? data.filter(function (r) { return r && STATUSES.indexOf(r.status) !== -1; }) : [];
    }

    function writeQueue(items) {
      return !!storage && writeJson(storage, DEMO_QUEUE_KEY, items);
    }

    function readLog() {
      var data = storage ? readJson(storage, SUBMISSION_LOG_KEY, []) : [];
      return Array.isArray(data) ? data : [];
    }

    function writeLog(entries) {
      var cutoff = clock() - LIMITS.duplicateWindowMs;
      return !!storage && writeJson(storage, SUBMISSION_LOG_KEY, entries.filter(function (e) { return e && e.at > cutoff; }).slice(-50));
    }

    function unavailable() {
      return { ok: false, kind: 'unavailable', message: UNAVAILABLE_MESSAGE, errors: {} };
    }

    function moderatorOnly(error) {
      return error && (error.code === 'unauthenticated' || error.code === 'forbidden');
    }

    /**
     * Public listing. seed: records from assets/data/health-events.json, used
     * when the backend has no list (or cannot be reached). In demo mode the
     * browser's demo queue is added, except rejected records.
     */
    async function publicEvents(seed) {
      if (hasApi('listHealthEvents')) {
        try {
          var answer = await api.listHealthEvents();
          var rows = Array.isArray(answer) ? answer : (answer && Array.isArray(answer.events) ? answer.events : null);
          if (rows) return { ok: true, mode: 'server', demo: false, events: normalizeEvents(rows) };
        } catch (error) {
          // Fall through to the published data file.
        }
      }
      var list = Array.isArray(seed) ? seed.slice() : [];
      if (demo) {
        readQueue().forEach(function (r) {
          if (r.status !== 'rejected') list.push(Object.assign({}, r, { demo: true }));
        });
      }
      return { ok: true, mode: demo ? 'demo' : 'static', demo: demo, events: normalizeEvents(list) };
    }

    async function submit(input) {
      var now = clock();
      var checked = validateSubmission(input, { now: now });
      if (checked.spam) return { ok: false, kind: 'spam', message: checked.errors.form, errors: checked.errors };
      if (!checked.valid) return { ok: false, kind: 'invalid', message: 'Please fix the highlighted fields.', errors: checked.errors };

      var limit = checkRateLimit(readLog(), now, checked.clean, d.limits);
      if (!limit.allowed) {
        return { ok: false, kind: limit.reason === 'duplicate' ? 'duplicate' : 'rate-limited', message: limit.message, errors: {} };
      }

      var done = function (mode, submission) {
        var log = readLog();
        log.push({ at: now, fingerprint: fingerprint(checked.clean) });
        writeLog(log);
        return { ok: true, mode: mode, demo: mode === 'demo', submission: submission };
      };

      if (hasApi('submitHealthEvent')) {
        try {
          // Only the cleaned fields are sent. The server sets the status, never the page.
          var answer = await api.submitHealthEvent(Object.assign({}, checked.clean));
          return done('server', answer);
        } catch (error) {
          if (error && error.code === 'rate-limited') {
            return { ok: false, kind: 'rate-limited', message: 'Too many submissions. Please try again later.', errors: {} };
          }
          if (error && error.code === 'rejected') {
            return { ok: false, kind: 'invalid', message: 'The review service did not accept this event.', errors: (error.details && error.details.errors) || {} };
          }
          if (!demo) return unavailable();
        }
      } else if (!demo) {
        return unavailable();
      }

      var queue = readQueue();
      var pending = queue.filter(function (r) { return r.status === 'pending'; });
      var fp = fingerprint(checked.clean);
      if (pending.some(function (r) { return fingerprint(r) === fp; })) {
        return { ok: false, kind: 'duplicate', message: 'This event is already waiting for review.', errors: {} };
      }
      if (pending.length >= LIMITS.maxDemoPending) {
        return { ok: false, kind: 'queue-full', message: 'The demo review queue is full.', errors: {} };
      }
      var submission = buildSubmission(checked.clean, { now: now, id: typeof d.idFn === 'function' ? d.idFn() : undefined });
      submission.demo = true;
      queue.push(submission);
      if (!writeQueue(queue)) {
        return { ok: false, kind: 'storage', message: 'Browser storage is unavailable, so the demo submission could not be saved.', errors: {} };
      }
      return done('demo', submission);
    }

    // Moderators. filter: { status: 'pending' | 'confirmed' | 'rejected' | 'all' }
    async function list(filter) {
      var status = filter && filter.status && filter.status !== 'all' ? filter.status : null;
      if (hasApi('listHealthEventSubmissions')) {
        try {
          var answer = await api.listHealthEventSubmissions(status ? { status: status } : {});
          var rows = Array.isArray(answer) ? answer : (answer && Array.isArray(answer.submissions) ? answer.submissions : null);
          if (rows) return { ok: true, mode: 'server', demo: false, items: rows.filter(function (r) { return r && STATUSES.indexOf(r.status) !== -1; }) };
        } catch (error) {
          if (moderatorOnly(error)) return { ok: false, kind: error.code, message: 'You need a moderator account to review events.', errors: {} };
        }
        if (!demo) return unavailable();
      } else if (!demo) {
        return unavailable();
      }
      var all = readQueue();
      return { ok: true, mode: 'demo', demo: true, items: status ? all.filter(function (r) { return r.status === status; }) : all };
    }

    // decision: { decision, actor, reason, evidence }
    async function review(id, decision) {
      var dec = decision || {};
      if (hasApi('reviewHealthEventSubmission')) {
        var pre = decide({ status: 'pending' }, dec, { now: clock() });
        if (!pre.ok && (pre.errors.decision || pre.errors.evidence || pre.errors.reason)) {
          return { ok: false, kind: 'invalid', message: 'Please fix the highlighted fields.', errors: pre.errors };
        }
        try {
          // The server names the moderator from their login. The page does not send an actor.
          var answer = await api.reviewHealthEventSubmission(id, {
            decision: dec.decision,
            reason: sanitizeText(dec.reason, LIMITS.maxNote),
            evidence: sanitizeText(dec.evidence, LIMITS.maxNote)
          });
          return { ok: true, mode: 'server', demo: false, submission: answer };
        } catch (error) {
          if (moderatorOnly(error)) return { ok: false, kind: error.code, message: 'You need a moderator account to review events.', errors: {} };
          if (error && error.code === 'rejected') {
            return { ok: false, kind: 'invalid', message: 'The review service did not accept this decision.', errors: (error.details && error.details.errors) || {} };
          }
          if (!demo) return unavailable();
        }
      } else if (!demo) {
        return unavailable();
      }

      var queue = readQueue();
      var index = -1;
      for (var i = 0; i < queue.length; i++) { if (queue[i].id === id) { index = i; break; } }
      if (index === -1) return { ok: false, kind: 'not-found', message: 'That submission could not be found.', errors: {} };
      var result = decide(queue[index], dec, { now: clock() });
      if (!result.ok) {
        return { ok: false, kind: result.errors.form ? 'final' : 'invalid', message: result.errors.form || 'Please fix the highlighted fields.', errors: result.errors };
      }
      queue[index] = result.record;
      if (!writeQueue(queue)) return { ok: false, kind: 'storage', message: 'Browser storage is unavailable, so the decision could not be saved.', errors: {} };
      return { ok: true, mode: 'demo', demo: true, submission: result.record };
    }

    return { publicEvents: publicEvents, submit: submit, list: list, review: review };
  }

  return {
    DEMO_QUEUE_KEY: DEMO_QUEUE_KEY,
    SUBMISSION_LOG_KEY: SUBMISSION_LOG_KEY,
    STATUSES: STATUSES.slice(),
    TYPES: TYPES,
    LIMITS: LIMITS,
    UNAVAILABLE_MESSAGE: UNAVAILABLE_MESSAGE,
    sanitizeText: sanitizeText,
    parseServices: parseServices,
    isValidDate: isValidDate,
    isValidTime: isValidTime,
    toIstIso: toIstIso,
    parseInstant: parseInstant,
    istDate: istDate,
    timeState: timeState,
    normalizeEvent: normalizeEvent,
    normalizeEvents: normalizeEvents,
    isConfirmed: isConfirmed,
    validateFilters: validateFilters,
    filterEvents: filterEvents,
    partitionByTime: partitionByTime,
    districts: districts,
    validateSubmission: validateSubmission,
    fingerprint: fingerprint,
    checkRateLimit: checkRateLimit,
    buildSubmission: buildSubmission,
    decide: decide,
    createStore: createStore
  };
}));
