package store

import (
	"os"
	"testing"

	"bandwidthquality/internal/engine"
)

func TestHighBandwidthDefaults(t *testing.T) {
	s := DefaultSettings()
	if s.Mode != engine.ModeMulti || s.LengthS != 13 || s.DownThreads != 16 || s.UpThreads != 8 || s.Family != engine.FamilyBoth || !s.IPv6 {
		t.Fatalf("unexpected defaults: %+v", s)
	}
	o := s.ToOptions()
	if o.Mode != engine.DefaultMode || o.LengthS != engine.DefaultLengthS || o.DownThreads != engine.DefaultDownThreads || o.UpThreads != engine.DefaultUpThreads {
		t.Fatalf("store/engine defaults differ: %+v", o)
	}
	empty := Settings{IPv6: true}
	empty.Normalize()
	if empty != s {
		t.Fatalf("zero-value defaults differ: %+v", empty)
	}
}

func TestLoadSettingsDefaultsAndPreserveExisting(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      Settings
	}{
		{"missing", "", DefaultSettings()},
		{"empty", "{}", DefaultSettings()},
		{"partial", `{"mode":"single"}`, Settings{Mode: engine.ModeSingle, LengthS: 13, DownThreads: 16, UpThreads: 8, Family: engine.FamilyBoth, IPv6: true}},
		{"old defaults", `{"mode":"both","lengthS":5,"downThreads":8,"upThreads":4,"family":"both"}`, Settings{Mode: engine.ModeBoth, LengthS: 5, DownThreads: 8, UpThreads: 4, Family: engine.FamilyBoth, IPv6: true}},
		{"custom", `{"mode":"single","lengthS":9,"downThreads":32,"upThreads":12,"family":"v4"}`, Settings{Mode: engine.ModeSingle, LengthS: 9, DownThreads: 32, UpThreads: 12, Family: engine.FamilyV4}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			// Isolate settings on Windows, Linux and macOS; never touch real user files.
			t.Setenv("APPDATA", dir)
			t.Setenv("XDG_CONFIG_HOME", dir)
			t.Setenv("HOME", dir)
			path, err := settingsPath()
			if err != nil {
				t.Fatal(err)
			}
			if tc.raw != "" {
				if err := os.WriteFile(path, []byte(tc.raw), 0600); err != nil {
					t.Fatal(err)
				}
			}
			got, err := LoadSettings()
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
			if err := SaveSettings(got); err != nil {
				t.Fatal(err)
			}
			again, err := LoadSettings()
			if err != nil {
				t.Fatal(err)
			}
			if again != tc.want {
				t.Fatalf("roundtrip changed settings: %+v", again)
			}
		})
	}
}
