/*
 * TracTrac tracker provider (placeholder).
 *
 * The only TracTrac document we have (tracker_docs/TracTrac_Event.pdf) is a pricing
 * brochure: API access comes with their "Gold" pack and is not documented. The
 * provider is listed so the platform choice exists in the UI, but cannot load events yet.
 */
(function (root) {
  'use strict';

  const TracTrac = {
    id: 'tractrac',
    name: 'TracTrac',
    available: false,
    unavailableReason: 'TracTrac is not supported yet: its API is only available with the TracTrac "Gold" pack and is not documented.',
    events: [],

    async loadEvent() {
      throw new Error(TracTrac.unavailableReason);
    },
  };

  root.TrackerProviders = root.TrackerProviders || {};
  root.TrackerProviders.tractrac = TracTrac;
})(typeof window !== 'undefined' ? window : globalThis);
