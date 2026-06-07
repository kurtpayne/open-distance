// Auto-generated from scripts/benchmark_panel.py output. Regenerate via:
//   python3 scripts/benchmark_panel.py --out /tmp/od-panel.md
//   python3 scripts/panel_to_ts.py /tmp/od-panel.md > src/panel_data.ts

export interface PanelSnapshot {
  generated: string;
  providers: string[];
  routes_total: number;
  distance: Record<string, CategoryStat>;
  duration: Record<string, CategoryStat>;
  distance_miles: RouteRow[];
  duration_minutes: RouteRow[];
}
export interface CategoryStat {
  routes: number;
  spread: number;
  providers: Record<string, number | null>;
}
export interface RouteRow {
  route: string;
  category: string;
  values: Record<string, number | null>;
  spread: number | null;
}

export const PANEL_SNAPSHOT: PanelSnapshot = {
  generated: "2026-06-07",
  providers: ["open-distance", "google", "osrm", "mapbox", "ors", "graphhopper", "tomtom", "valhalla"],
  routes_total: 44,
  distance: {
    commute: {
      routes: 8,
      spread: 13.2,
      providers: {
        "open-distance": -0.4,
        google: 0.6,
        osrm: 0.0,
        mapbox: -0.0,
        ors: -0.0,
        graphhopper: -0.4,
        tomtom: 0.5,
        valhalla: 3.1
      }
    },
    cross_state: {
      routes: 6,
      spread: 14.8,
      providers: {
        "open-distance": -4.4,
        google: -0.0,
        osrm: -0.4,
        mapbox: 0.1,
        ors: -0.4,
        graphhopper: 1.2,
        tomtom: 0.3,
        valhalla: 4.4
      }
    },
    inter_city: {
      routes: 4,
      spread: 2.5,
      providers: {
        "open-distance": -0.7,
        google: -0.0,
        osrm: -0.3,
        mapbox: 0.1,
        ors: -0.3,
        graphhopper: -0.0,
        tomtom: 0.0,
        valhalla: 0.1
      }
    },
    long: {
      routes: 11,
      spread: 4.2,
      providers: {
        "open-distance": 0.7,
        google: -0.0,
        osrm: -0.2,
        mapbox: 0.1,
        ors: -0.0,
        graphhopper: -0.2,
        tomtom: 0.1,
        valhalla: 0.1
      }
    },
    rural: {
      routes: 5,
      spread: 0.7,
      providers: {
        "open-distance": -0.3,
        google: -0.0,
        osrm: -0.0,
        mapbox: 0.1,
        ors: 0.0,
        graphhopper: -0.0,
        tomtom: 0.0,
        valhalla: 0.1
      }
    },
    "short urban": {
      routes: 4,
      spread: 29.0,
      providers: {
        "open-distance": -11.4,
        google: 7.8,
        osrm: 2.2,
        mapbox: -3.7,
        ors: -2.2,
        graphhopper: -8.2,
        tomtom: 8.0,
        valhalla: 6.3
      }
    },
    traffic: {
      routes: 6,
      spread: 19.2,
      providers: {
        "open-distance": -5.1,
        google: 1.8,
        osrm: -2.1,
        mapbox: 0.0,
        ors: -0.9,
        graphhopper: 0.3,
        tomtom: 2.9,
        valhalla: 1.5
      }
    }
  },
  duration: {
    commute: {
      routes: 8,
      spread: 69.0,
      providers: {
        "open-distance": -23.8,
        google: 10.8,
        osrm: -0.9,
        mapbox: 42.4,
        ors: 10.1,
        graphhopper: -7.5,
        tomtom: 24.6,
        valhalla: -17.3
      }
    },
    cross_state: {
      routes: 6,
      spread: 52.8,
      providers: {
        "open-distance": -25.9,
        google: 3.8,
        osrm: -2.1,
        mapbox: 22.2,
        ors: 7.6,
        graphhopper: -1.9,
        tomtom: 0.7,
        valhalla: -5.0
      }
    },
    inter_city: {
      routes: 4,
      spread: 26.4,
      providers: {
        "open-distance": -5.3,
        google: -2.4,
        osrm: 18.6,
        mapbox: 12.3,
        ors: 11.3,
        graphhopper: 0.7,
        tomtom: -1.1,
        valhalla: -5.0
      }
    },
    long: {
      routes: 11,
      spread: 28.4,
      providers: {
        "open-distance": 0.5,
        google: -2.1,
        osrm: 20.8,
        mapbox: 5.4,
        ors: 12.9,
        graphhopper: -1.0,
        tomtom: -6.3,
        valhalla: -2.9
      }
    },
    rural: {
      routes: 5,
      spread: 24.6,
      providers: {
        "open-distance": -7.1,
        google: -2.3,
        osrm: 13.3,
        mapbox: 3.0,
        ors: 4.3,
        graphhopper: 0.0,
        tomtom: -4.1,
        valhalla: -7.1
      }
    },
    "short urban": {
      routes: 4,
      spread: 151.8,
      providers: {
        "open-distance": -45.3,
        google: 63.2,
        osrm: -6.2,
        mapbox: 86.6,
        ors: 3.5,
        graphhopper: -9.9,
        tomtom: 95.5,
        valhalla: -20.2
      }
    },
    traffic: {
      routes: 6,
      spread: 85.4,
      providers: {
        "open-distance": -31.4,
        google: 8.5,
        osrm: -5.2,
        mapbox: 45.1,
        ors: 8.5,
        graphhopper: -9.5,
        tomtom: 47.5,
        valhalla: -19.1
      }
    }
  },
  distance_miles: [{
  route: "SF Civic Center -> SF Ferry Building",
  category: "short urban",
  values: {
    "open-distance": 2.2,
    google: 2.3,
    osrm: 2.8,
    mapbox: 2.2,
    ors: 2.7,
    graphhopper: 2.8,
    tomtom: 2.2,
    valhalla: 3.1
  },
  spread: 35.9
}, {
  route: "Manhattan Times Sq -> Penn Station",
  category: "short urban",
  values: {
    "open-distance": 1.0,
    google: 1.0,
    osrm: 0.9,
    mapbox: 0.8,
    ors: 0.9,
    graphhopper: 0.8,
    tomtom: 1.0,
    valhalla: 0.8
  },
  spread: 24.1
}, {
  route: "DTLA Pershing Sq -> LA Live",
  category: "short urban",
  values: {
    "open-distance": 1.3,
    google: 1.7,
    osrm: 1.3,
    mapbox: 1.8,
    ors: 1.3,
    graphhopper: 1.4,
    tomtom: 1.7,
    valhalla: 1.8
  },
  spread: 33.9
}, {
  route: "Boston Faneuil Hall -> Fenway",
  category: "short urban",
  values: {
    "open-distance": 2.6,
    google: 3.1,
    osrm: 3.1,
    mapbox: 3.1,
    ors: 2.8,
    graphhopper: 2.8,
    tomtom: 3.1,
    valhalla: 2.8
  },
  spread: 16.3
}, {
  route: "Palo Alto -> Mountain View",
  category: "commute",
  values: {
    "open-distance": 6.8,
    google: 7.9,
    osrm: 7.9,
    mapbox: 7.9,
    ors: 7.9,
    graphhopper: 7.9,
    tomtom: 8.1,
    valhalla: 7.9
  },
  spread: 16.1
}, {
  route: "San Mateo -> Foster City",
  category: "commute",
  values: {
    "open-distance": 4.2,
    google: 4.5,
    osrm: 4.5,
    mapbox: 4.4,
    ors: 4.5,
    graphhopper: 4.4,
    tomtom: 4.4,
    valhalla: 4.8
  },
  spread: 13.3
}, {
  route: "Brooklyn -> Newark Penn Station",
  category: "commute",
  values: {
    "open-distance": 14.4,
    google: 14.0,
    osrm: 14.5,
    mapbox: 14.1,
    ors: 15.4,
    graphhopper: 14.1,
    tomtom: 14.6,
    valhalla: 14.9
  },
  spread: 9.3
}, {
  route: "Bethesda MD -> DC Capitol",
  category: "commute",
  values: {
    "open-distance": 9.1,
    google: 21.6,
    osrm: 9.5,
    mapbox: 12.1,
    ors: 10.5,
    graphhopper: 9.2,
    tomtom: 21.6,
    valhalla: 11.3
  },
  spread: 114.8
}, {
  route: "Cambridge MA -> Logan Airport",
  category: "commute",
  values: {
    "open-distance": 6.5,
    google: 8.9,
    osrm: 6.2,
    mapbox: 6.3,
    ors: null,
    graphhopper: 6.2,
    tomtom: 9.4,
    valhalla: 6.6
  },
  spread: 49.3
}, {
  route: "Pasadena -> Santa Monica",
  category: "commute",
  values: {
    "open-distance": 24.9,
    google: 25.0,
    osrm: 25.1,
    mapbox: 25.0,
    ors: 28.2,
    graphhopper: 25.0,
    tomtom: 25.0,
    valhalla: 25.1
  },
  spread: 13.0
}, {
  route: "Plano TX -> Downtown Dallas",
  category: "commute",
  values: {
    "open-distance": 19.1,
    google: 19.9,
    osrm: 19.2,
    mapbox: 19.3,
    ors: 19.2,
    graphhopper: 19.2,
    tomtom: 19.1,
    valhalla: 20.0
  },
  spread: 4.9
}, {
  route: "Naperville IL -> Chicago Loop",
  category: "commute",
  values: {
    "open-distance": 33.1,
    google: 33.3,
    osrm: 33.1,
    mapbox: 33.1,
    ors: 32.8,
    graphhopper: 33.1,
    tomtom: 33.3,
    valhalla: 34.4
  },
  spread: 4.8
}, {
  route: "SF -> Sacramento",
  category: "inter_city",
  values: {
    "open-distance": 87.0,
    google: 87.9,
    osrm: 87.4,
    mapbox: 88.0,
    ors: 87.3,
    graphhopper: 87.9,
    tomtom: 87.9,
    valhalla: 88.0
  },
  spread: 1.1
}, {
  route: "LA -> San Diego",
  category: "inter_city",
  values: {
    "open-distance": 121.9,
    google: 120.3,
    osrm: 121.3,
    mapbox: 124.2,
    ors: 120.3,
    graphhopper: 120.3,
    tomtom: 127.9,
    valhalla: 121.1
  },
  spread: 6.3
}, {
  route: "Houston -> Austin",
  category: "inter_city",
  values: {
    "open-distance": 162.2,
    google: 165.3,
    osrm: 162.4,
    mapbox: 165.4,
    ors: 165.3,
    graphhopper: 165.3,
    tomtom: 165.5,
    valhalla: 165.4
  },
  spread: 2.0
}, {
  route: "Detroit -> Lansing",
  category: "inter_city",
  values: {
    "open-distance": 90.4,
    google: 90.6,
    osrm: 90.7,
    mapbox: 90.6,
    ors: 93.1,
    graphhopper: 90.5,
    tomtom: 90.6,
    valhalla: 90.7
  },
  spread: 3.0
}, {
  route: "SF -> LA",
  category: "long",
  values: {
    "open-distance": 417.5,
    google: 383.1,
    osrm: 380.8,
    mapbox: 381.9,
    ors: 382.5,
    graphhopper: 381.5,
    tomtom: 411.2,
    valhalla: 381.9
  },
  spread: 9.6
}, {
  route: "Seattle -> Portland",
  category: "long",
  values: {
    "open-distance": 173.8,
    google: 174.0,
    osrm: 174.1,
    mapbox: 174.2,
    ors: 180.7,
    graphhopper: 174.0,
    tomtom: 174.2,
    valhalla: 181.7
  },
  spread: 4.5
}, {
  route: "NYC -> Boston",
  category: "long",
  values: {
    "open-distance": 215.6,
    google: 215.2,
    osrm: 213.6,
    mapbox: 215.3,
    ors: 215.2,
    graphhopper: 214.0,
    tomtom: 216.5,
    valhalla: 216.3
  },
  spread: 1.4
}, {
  route: "NYC -> DC",
  category: "long",
  values: {
    "open-distance": 226.0,
    google: 226.2,
    osrm: 226.2,
    mapbox: 227.1,
    ors: 228.1,
    graphhopper: 226.1,
    tomtom: 231.9,
    valhalla: 226.6
  },
  spread: 2.6
}, {
  route: "Atlanta -> Miami",
  category: "long",
  values: {
    "open-distance": 662.4,
    google: 664.7,
    osrm: 661.4,
    mapbox: 663.3,
    ors: 662.5,
    graphhopper: 662.7,
    tomtom: 661.4,
    valhalla: 663.4
  },
  spread: 0.5
}, {
  route: "Chicago -> Detroit",
  category: "long",
  values: {
    "open-distance": 299.7,
    google: 282.6,
    osrm: 281.6,
    mapbox: 282.9,
    ors: 282.6,
    graphhopper: 282.6,
    tomtom: 283.1,
    valhalla: 282.9
  },
  spread: 6.4
}, {
  route: "Denver -> Salt Lake City",
  category: "long",
  values: {
    "open-distance": 524.6,
    google: 521.0,
    osrm: 521.4,
    mapbox: 520.8,
    ors: 535.0,
    graphhopper: 520.8,
    tomtom: 519.2,
    valhalla: 517.8
  },
  spread: 3.3
}, {
  route: "Dallas -> Houston",
  category: "long",
  values: {
    "open-distance": 248.4,
    google: 239.0,
    osrm: 238.3,
    mapbox: 239.3,
    ors: 238.8,
    graphhopper: 239.0,
    tomtom: 238.5,
    valhalla: 239.4
  },
  spread: 4.2
}, {
  route: "NYC -> LA",
  category: "long",
  values: {
    "open-distance": 3004.9,
    google: 2789.5,
    osrm: 2798.4,
    mapbox: 2778.1,
    ors: 2793.5,
    graphhopper: 2775.9,
    tomtom: 2820.5,
    valhalla: 2793.9
  },
  spread: 8.2
}, {
  route: "Seattle -> Miami",
  category: "long",
  values: {
    "open-distance": 3459.9,
    google: 3299.1,
    osrm: 3325.4,
    mapbox: 3337.9,
    ors: 3329.1,
    graphhopper: 3328.5,
    tomtom: 3358.4,
    valhalla: 3342.7
  },
  spread: 4.8
}, {
  route: "Boston -> Houston",
  category: "long",
  values: {
    "open-distance": 1846.5,
    google: 1847.5,
    osrm: 1841.4,
    mapbox: 1853.1,
    ors: 1866.8,
    graphhopper: 1839.7,
    tomtom: 1848.4,
    valhalla: 1872.8
  },
  spread: 1.8
}, {
  route: "Niles MI -> Mishawaka IN",
  category: "cross_state",
  values: {
    "open-distance": 16.3,
    google: 16.4,
    osrm: 14.8,
    mapbox: 16.9,
    ors: 17.0,
    graphhopper: 17.3,
    tomtom: 16.9,
    valhalla: 16.9
  },
  spread: 14.8
}, {
  route: "KCK -> KCMO",
  category: "cross_state",
  values: {
    "open-distance": 3.2,
    google: 3.4,
    osrm: 3.4,
    mapbox: 3.4,
    ors: 3.4,
    graphhopper: 3.4,
    tomtom: 3.4,
    valhalla: 3.8
  },
  spread: 17.1
}, {
  route: "Memphis TN -> West Memphis AR",
  category: "cross_state",
  values: {
    "open-distance": 8.6,
    google: 9.8,
    osrm: 8.6,
    mapbox: 9.8,
    ors: 8.6,
    graphhopper: 9.9,
    tomtom: 8.6,
    valhalla: 9.3
  },
  spread: 14.6
}, {
  route: "Vancouver WA -> Portland OR",
  category: "cross_state",
  values: {
    "open-distance": 8.8,
    google: 9.0,
    osrm: 9.0,
    mapbox: 9.1,
    ors: 18.9,
    graphhopper: 9.0,
    tomtom: 9.2,
    valhalla: 9.8
  },
  spread: 111.2
}, {
  route: "Jersey City NJ -> Manhattan",
  category: "cross_state",
  values: {
    "open-distance": 3.6,
    google: 4.0,
    osrm: 3.9,
    mapbox: 3.8,
    ors: 3.9,
    graphhopper: 3.8,
    tomtom: 3.9,
    valhalla: 4.1
  },
  spread: 13.9
}, {
  route: "Camden NJ -> Philly Center City",
  category: "cross_state",
  values: {
    "open-distance": 4.6,
    google: 5.1,
    osrm: 5.1,
    mapbox: 5.3,
    ors: 4.7,
    graphhopper: 5.3,
    tomtom: 5.3,
    valhalla: 5.1
  },
  spread: 14.8
}, {
  route: "Bozeman MT -> Yellowstone (West)",
  category: "rural",
  values: {
    "open-distance": 88.8,
    google: 89.0,
    osrm: 89.0,
    mapbox: 89.1,
    ors: 89.0,
    graphhopper: 89.0,
    tomtom: 89.0,
    valhalla: 89.1
  },
  spread: 0.3
}, {
  route: "Eureka CA -> Crescent City",
  category: "rural",
  values: {
    "open-distance": 84.0,
    google: 84.4,
    osrm: 84.2,
    mapbox: 84.5,
    ors: 84.2,
    graphhopper: 84.3,
    tomtom: 84.2,
    valhalla: 84.5
  },
  spread: 0.6
}, {
  route: "Bangor ME -> Acadia NP",
  category: "rural",
  values: {
    "open-distance": 43.8,
    google: 43.8,
    osrm: 43.8,
    mapbox: 43.8,
    ors: null,
    graphhopper: 47.1,
    tomtom: 47.5,
    valhalla: 44.1
  },
  spread: 8.5
}, {
  route: "Pierre SD -> Rapid City",
  category: "rural",
  values: {
    "open-distance": 178.9,
    google: 172.7,
    osrm: 191.6,
    mapbox: 191.5,
    ors: 191.3,
    graphhopper: 191.3,
    tomtom: 173.0,
    valhalla: 191.5
  },
  spread: 9.9
}, {
  route: "Cheyenne WY -> Casper",
  category: "rural",
  values: {
    "open-distance": 177.3,
    google: 178.4,
    osrm: 178.4,
    mapbox: 178.5,
    ors: null,
    graphhopper: 178.2,
    tomtom: 178.4,
    valhalla: 178.4
  },
  spread: 0.7
}, {
  route: "SF -> Berkeley (Bay Bridge)",
  category: "traffic",
  values: {
    "open-distance": 13.1,
    google: 13.6,
    osrm: 13.1,
    mapbox: 13.6,
    ors: 13.0,
    graphhopper: 13.6,
    tomtom: 14.1,
    valhalla: 13.6
  },
  spread: 7.6
}, {
  route: "Newark Airport -> Manhattan (Lincoln Tunnel)",
  category: "traffic",
  values: {
    "open-distance": 15.8,
    google: 16.8,
    osrm: 16.3,
    mapbox: 16.8,
    ors: 16.3,
    graphhopper: 16.9,
    tomtom: 16.8,
    valhalla: 16.8
  },
  spread: 6.5
}, {
  route: "LAX -> Hollywood (405+101)",
  category: "traffic",
  values: {
    "open-distance": 14.5,
    google: 24.0,
    osrm: 15.2,
    mapbox: 15.1,
    ors: 23.1,
    graphhopper: 23.9,
    tomtom: 24.0,
    valhalla: 24.2
  },
  spread: 41.3
}, {
  route: "Tysons Corner -> DC Capitol (I-66+I-395)",
  category: "traffic",
  values: {
    "open-distance": 14.2,
    google: 18.6,
    osrm: 14.8,
    mapbox: 14.2,
    ors: 24.0,
    graphhopper: 14.0,
    tomtom: 18.6,
    valhalla: 14.2
  },
  spread: 68.8
}, {
  route: "Marina del Rey -> LAX (405)",
  category: "traffic",
  values: {
    "open-distance": 6.3,
    google: 6.7,
    osrm: 6.6,
    mapbox: 6.6,
    ors: 6.6,
    graphhopper: 7.1,
    tomtom: 6.6,
    valhalla: 7.1
  },
  spread: 12.0
}, {
  route: "Cambridge MA -> Boston Common (I-93)",
  category: "traffic",
  values: {
    "open-distance": 2.7,
    google: 3.3,
    osrm: 3.2,
    mapbox: 3.2,
    ors: 3.2,
    graphhopper: 3.2,
    tomtom: 3.6,
    valhalla: 3.5
  },
  spread: 26.4
}],
  duration_minutes: [{
  route: "SF Civic Center -> SF Ferry Building",
  category: "short urban",
  values: {
    "open-distance": 6.0,
    google: 17.0,
    osrm: 9.0,
    mapbox: 17.0,
    ors: 9.0,
    graphhopper: 11.0,
    tomtom: 20.0,
    valhalla: 8.0
  },
  spread: 151.7
}, {
  route: "Manhattan Times Sq -> Penn Station",
  category: "short urban",
  values: {
    "open-distance": 2.0,
    google: 9.0,
    osrm: 3.0,
    mapbox: 7.0,
    ors: 4.0,
    graphhopper: 3.0,
    tomtom: 15.0,
    valhalla: 3.0
  },
  spread: 370.6
}, {
  route: "DTLA Pershing Sq -> LA Live",
  category: "short urban",
  values: {
    "open-distance": 2.0,
    google: 6.0,
    osrm: 3.0,
    mapbox: 9.0,
    ors: 5.0,
    graphhopper: 4.0,
    tomtom: 8.0,
    valhalla: 4.0
  },
  spread: 152.0
}, {
  route: "Boston Faneuil Hall -> Fenway",
  category: "short urban",
  values: {
    "open-distance": 6.0,
    google: 13.0,
    osrm: 9.0,
    mapbox: 14.0,
    ors: 9.0,
    graphhopper: 8.0,
    tomtom: 15.0,
    valhalla: 6.0
  },
  spread: 103.5
}, {
  route: "Palo Alto -> Mountain View",
  category: "commute",
  values: {
    "open-distance": 10.0,
    google: 13.0,
    osrm: 13.0,
    mapbox: 15.0,
    ors: 14.0,
    graphhopper: 12.0,
    tomtom: 14.0,
    valhalla: 10.0
  },
  spread: 42.3
}, {
  route: "San Mateo -> Foster City",
  category: "commute",
  values: {
    "open-distance": 6.0,
    google: 11.0,
    osrm: 8.0,
    mapbox: 11.0,
    ors: 10.0,
    graphhopper: 8.0,
    tomtom: 11.0,
    valhalla: 7.0
  },
  spread: 62.5
}, {
  route: "Brooklyn -> Newark Penn Station",
  category: "commute",
  values: {
    "open-distance": 24.0,
    google: 48.0,
    osrm: 32.0,
    mapbox: 58.0,
    ors: 36.0,
    graphhopper: 33.0,
    tomtom: 49.0,
    valhalla: 29.0
  },
  spread: 97.1
}, {
  route: "Bethesda MD -> DC Capitol",
  category: "commute",
  values: {
    "open-distance": 18.0,
    google: 38.0,
    osrm: 25.0,
    mapbox: 43.0,
    ors: 31.0,
    graphhopper: 27.0,
    tomtom: 37.0,
    valhalla: 29.0
  },
  spread: 85.0
}, {
  route: "Cambridge MA -> Logan Airport",
  category: "commute",
  values: {
    "open-distance": 13.0,
    google: 19.0,
    osrm: 17.0,
    mapbox: 23.0,
    ors: null,
    graphhopper: 16.0,
    tomtom: 25.0,
    valhalla: 13.0
  },
  spread: 70.6
}, {
  route: "Pasadena -> Santa Monica",
  category: "commute",
  values: {
    "open-distance": 27.0,
    google: 36.0,
    osrm: 35.0,
    mapbox: 51.0,
    ors: 41.0,
    graphhopper: 30.0,
    tomtom: 44.0,
    valhalla: 28.0
  },
  spread: 67.5
}, {
  route: "Plano TX -> Downtown Dallas",
  category: "commute",
  values: {
    "open-distance": 18.0,
    google: 25.0,
    osrm: 24.0,
    mapbox: 37.0,
    ors: 23.0,
    graphhopper: 22.0,
    tomtom: 24.0,
    valhalla: 20.0
  },
  spread: 79.3
}, {
  route: "Naperville IL -> Chicago Loop",
  category: "commute",
  values: {
    "open-distance": 39.0,
    google: 44.0,
    osrm: 51.0,
    mapbox: 53.0,
    ors: 58.0,
    graphhopper: 46.0,
    tomtom: 64.0,
    valhalla: 41.0
  },
  spread: 50.0
}, {
  route: "SF -> Sacramento",
  category: "inter_city",
  values: {
    "open-distance": 84.0,
    google: 89.0,
    osrm: 107.0,
    mapbox: 109.0,
    ors: 103.0,
    graphhopper: 90.0,
    tomtom: 95.0,
    valhalla: 87.0
  },
  spread: 26.3
}, {
  route: "LA -> San Diego",
  category: "inter_city",
  values: {
    "open-distance": 116.0,
    google: 117.0,
    osrm: 147.0,
    mapbox: 143.0,
    ors: 135.0,
    graphhopper: 120.0,
    tomtom: 121.0,
    valhalla: 115.0
  },
  spread: 26.5
}, {
  route: "Houston -> Austin",
  category: "inter_city",
  values: {
    "open-distance": 147.0,
    google: 154.0,
    osrm: 180.0,
    mapbox: 167.0,
    ors: 166.0,
    graphhopper: 159.0,
    tomtom: 152.0,
    valhalla: 148.0
  },
  spread: 21.1
}, {
  route: "Detroit -> Lansing",
  category: "inter_city",
  values: {
    "open-distance": 84.0,
    google: 82.0,
    osrm: 105.0,
    mapbox: 84.0,
    ors: 99.0,
    graphhopper: 86.0,
    tomtom: 78.0,
    valhalla: 84.0
  },
  spread: 32.2
}, {
  route: "SF -> LA",
  category: "long",
  values: {
    "open-distance": 404.0,
    google: 355.0,
    osrm: 426.0,
    mapbox: 393.0,
    ors: 389.0,
    graphhopper: 348.0,
    tomtom: 363.0,
    valhalla: 341.0
  },
  spread: 22.7
}, {
  route: "Seattle -> Portland",
  category: "long",
  values: {
    "open-distance": 166.0,
    google: 166.0,
    osrm: 208.0,
    mapbox: 183.0,
    ors: 201.0,
    graphhopper: 171.0,
    tomtom: 159.0,
    valhalla: 173.0
  },
  spread: 28.6
}, {
  route: "NYC -> Boston",
  category: "long",
  values: {
    "open-distance": 225.0,
    google: 221.0,
    osrm: 281.0,
    mapbox: 256.0,
    ors: 287.0,
    graphhopper: 231.0,
    tomtom: 220.0,
    valhalla: 231.0
  },
  spread: 29.1
}, {
  route: "NYC -> DC",
  category: "long",
  values: {
    "open-distance": 230.0,
    google: 235.0,
    osrm: 290.0,
    mapbox: 258.0,
    ors: 278.0,
    graphhopper: 238.0,
    tomtom: 227.0,
    valhalla: 236.0
  },
  spread: 26.4
}, {
  route: "Atlanta -> Miami",
  category: "long",
  values: {
    "open-distance": 580.0,
    google: 572.0,
    osrm: 723.0,
    mapbox: 616.0,
    ors: 660.0,
    graphhopper: 587.0,
    tomtom: 536.0,
    valhalla: 578.0
  },
  spread: 32.0
}, {
  route: "Chicago -> Detroit",
  category: "long",
  values: {
    "open-distance": 275.0,
    google: 256.0,
    osrm: 318.0,
    mapbox: 271.0,
    ors: 299.0,
    graphhopper: 258.0,
    tomtom: 240.0,
    valhalla: 253.0
  },
  spread: 29.7
}, {
  route: "Denver -> Salt Lake City",
  category: "long",
  values: {
    "open-distance": 470.0,
    google: 473.0,
    osrm: 540.0,
    mapbox: 495.0,
    ors: 486.0,
    graphhopper: 449.0,
    tomtom: 454.0,
    valhalla: 433.0
  },
  spread: 22.7
}, {
  route: "Dallas -> Houston",
  category: "long",
  values: {
    "open-distance": 216.0,
    google: 209.0,
    osrm: 253.0,
    mapbox: 227.0,
    ors: 225.0,
    graphhopper: 207.0,
    tomtom: 193.0,
    valhalla: 203.0
  },
  spread: 28.4
}, {
  route: "NYC -> LA",
  category: "long",
  values: {
    "open-distance": 2603.0,
    google: 2463.0,
    osrm: 2988.0,
    mapbox: 2570.0,
    ors: 2693.0,
    graphhopper: 2421.0,
    tomtom: 2358.0,
    valhalla: 2392.0
  },
  spread: 25.0
}, {
  route: "Seattle -> Miami",
  category: "long",
  values: {
    "open-distance": 2926.0,
    google: 2896.0,
    osrm: 3530.0,
    mapbox: 3070.0,
    ors: 3188.0,
    graphhopper: 2883.0,
    tomtom: 2776.0,
    valhalla: 2827.0
  },
  spread: 25.9
}, {
  route: "Boston -> Houston",
  category: "long",
  values: {
    "open-distance": 1711.0,
    google: 1646.0,
    osrm: 2080.0,
    mapbox: 1737.0,
    ors: 1915.0,
    graphhopper: 1684.0,
    tomtom: 1566.0,
    valhalla: 1677.0
  },
  spread: 30.3
}, {
  route: "Niles MI -> Mishawaka IN",
  category: "cross_state",
  values: {
    "open-distance": 22.0,
    google: 28.0,
    osrm: 27.0,
    mapbox: 29.0,
    ors: 27.0,
    graphhopper: 29.0,
    tomtom: 27.0,
    valhalla: 23.0
  },
  spread: 26.9
}, {
  route: "KCK -> KCMO",
  category: "cross_state",
  values: {
    "open-distance": 5.0,
    google: 8.0,
    osrm: 7.0,
    mapbox: 8.0,
    ors: 8.0,
    graphhopper: 7.0,
    tomtom: 7.0,
    valhalla: 7.0
  },
  spread: 42.7
}, {
  route: "Memphis TN -> West Memphis AR",
  category: "cross_state",
  values: {
    "open-distance": 11.0,
    google: 14.0,
    osrm: 13.0,
    mapbox: 16.0,
    ors: 14.0,
    graphhopper: 14.0,
    tomtom: 14.0,
    valhalla: 13.0
  },
  spread: 36.2
}, {
  route: "Vancouver WA -> Portland OR",
  category: "cross_state",
  values: {
    "open-distance": 12.0,
    google: 15.0,
    osrm: 16.0,
    mapbox: 21.0,
    ors: 32.0,
    graphhopper: 14.0,
    tomtom: 15.0,
    valhalla: 15.0
  },
  spread: 138.0
}, {
  route: "Jersey City NJ -> Manhattan",
  category: "cross_state",
  values: {
    "open-distance": 7.0,
    google: 18.0,
    osrm: 11.0,
    mapbox: 20.0,
    ors: 12.0,
    graphhopper: 11.0,
    tomtom: 30.0,
    valhalla: 11.0
  },
  spread: 196.6
}, {
  route: "Camden NJ -> Philly Center City",
  category: "cross_state",
  values: {
    "open-distance": 7.0,
    google: 13.0,
    osrm: 10.0,
    mapbox: 13.0,
    ors: 12.0,
    graphhopper: 9.0,
    tomtom: 11.0,
    valhalla: 10.0
  },
  spread: 63.0
}, {
  route: "Bozeman MT -> Yellowstone (West)",
  category: "rural",
  values: {
    "open-distance": 92.0,
    google: 100.0,
    osrm: 115.0,
    mapbox: 105.0,
    ors: 107.0,
    graphhopper: 107.0,
    tomtom: 98.0,
    valhalla: 94.0
  },
  spread: 21.9
}, {
  route: "Eureka CA -> Crescent City",
  category: "rural",
  values: {
    "open-distance": 88.0,
    google: 94.0,
    osrm: 111.0,
    mapbox: 99.0,
    ors: 106.0,
    graphhopper: 101.0,
    tomtom: 93.0,
    valhalla: 89.0
  },
  spread: 24.0
}, {
  route: "Bangor ME -> Acadia NP",
  category: "rural",
  values: {
    "open-distance": 60.0,
    google: 64.0,
    osrm: 73.0,
    mapbox: 68.0,
    ors: null,
    graphhopper: 65.0,
    tomtom: 96.0,
    valhalla: 60.0
  },
  spread: 54.7
}, {
  route: "Pierre SD -> Rapid City",
  category: "rural",
  values: {
    "open-distance": 200.0,
    google: 160.0,
    osrm: 192.0,
    mapbox: 175.0,
    ors: 176.0,
    graphhopper: 164.0,
    tomtom: 156.0,
    valhalla: 159.0
  },
  spread: 26.0
}, {
  route: "Cheyenne WY -> Casper",
  category: "rural",
  values: {
    "open-distance": 143.0,
    google: 152.0,
    osrm: 179.0,
    mapbox: 162.0,
    ors: null,
    graphhopper: 149.0,
    tomtom: 143.0,
    valhalla: 147.0
  },
  spread: 24.6
}, {
  route: "SF -> Berkeley (Bay Bridge)",
  category: "traffic",
  values: {
    "open-distance": 18.0,
    google: 23.0,
    osrm: 23.0,
    mapbox: 34.0,
    ors: 28.0,
    graphhopper: 22.0,
    tomtom: 34.0,
    valhalla: 19.0
  },
  spread: 68.9
}, {
  route: "Newark Airport -> Manhattan (Lincoln Tunnel)",
  category: "traffic",
  values: {
    "open-distance": 22.0,
    google: 32.0,
    osrm: 32.0,
    mapbox: 43.0,
    ors: 33.0,
    graphhopper: 26.0,
    tomtom: 61.0,
    valhalla: 25.0
  },
  spread: 119.3
}, {
  route: "LAX -> Hollywood (405+101)",
  category: "traffic",
  values: {
    "open-distance": 23.0,
    google: 38.0,
    osrm: 30.0,
    mapbox: 53.0,
    ors: 39.0,
    graphhopper: 29.0,
    tomtom: 45.0,
    valhalla: 27.0
  },
  spread: 86.4
}, {
  route: "Tysons Corner -> DC Capitol (I-66+I-395)",
  category: "traffic",
  values: {
    "open-distance": 20.0,
    google: 29.0,
    osrm: 26.0,
    mapbox: 36.0,
    ors: 31.0,
    graphhopper: 24.0,
    tomtom: 30.0,
    valhalla: 25.0
  },
  spread: 58.8
}, {
  route: "Marina del Rey -> LAX (405)",
  category: "traffic",
  values: {
    "open-distance": 10.0,
    google: 20.0,
    osrm: 14.0,
    mapbox: 23.0,
    ors: 17.0,
    graphhopper: 15.0,
    tomtom: 24.0,
    valhalla: 13.0
  },
  spread: 84.3
}, {
  route: "Cambridge MA -> Boston Common (I-93)",
  category: "traffic",
  values: {
    "open-distance": 7.0,
    google: 19.0,
    osrm: 11.0,
    mapbox: 17.0,
    ors: 11.0,
    graphhopper: 12.0,
    tomtom: 20.0,
    valhalla: 10.0
  },
  spread: 117.1
}]
};
