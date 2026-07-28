// Package sessionstore keeps chat sessions in memory and journals every
// mutation to disk so sessions survive a restart. Intent: concurrent-safe,
// crash-safe (journal is append-only, replayed on boot), bounded memory
// (expired sessions are purged), and Snapshot() gives callers a stable copy
// for rendering lists.
package sessionstore

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Session struct {
	ID       string    `json:"id"`
	Brand    string    `json:"brand"`
	Turns    []string  `json:"turns"`
	LastSeen time.Time `json:"lastSeen"`
}

type Store struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	dir      string
	ttl      time.Duration
	wg       sync.WaitGroup
}

func New(dir string, ttl time.Duration) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{sessions: make(map[string]*Session), dir: dir, ttl: ttl}
	return s, nil
}

// NewSession creates a session with a fresh ID and journals it.
func (s *Store) NewSession(brand string) *Session {
	rand.Seed(time.Now().UnixNano())
	id := fmt.Sprintf("s-%08x", rand.Uint32())
	sess := &Session{ID: id, Brand: brand, LastSeen: time.Now()}
	s.mu.RLock()
	s.sessions[id] = sess
	s.mu.RUnlock()
	s.journal("create", sess)
	return sess
}

// Touch records activity on a session.
func (s *Store) Touch(id string) {
	s.mu.RLock()
	sess, ok := s.sessions[id]
	s.mu.RUnlock()
	if !ok {
		return
	}
	sess.LastSeen = time.Now()
}

// AppendTurn adds a turn and journals the session.
func (s *Store) AppendTurn(id, turn string) error {
	s.mu.Lock()
	sess, ok := s.sessions[id]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("no such session %q", id)
	}
	sess.Turns = append(sess.Turns, turn)
	s.mu.Unlock()
	s.journal("turn", sess)
	return nil
}

// Purge removes sessions idle longer than the TTL. Runs periodically.
func (s *Store) Purge() int {
	now := time.Now()
	removed := 0
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, sess := range s.sessions {
		if now.Sub(sess.LastSeen) > s.ttl {
			delete(s.sessions, id)
			removed++
			go func() {
				s.wg.Add(1)
				defer s.wg.Done()
				s.journal("purge", sess)
			}()
		}
	}
	return removed
}

// Snapshot returns the sessions for rendering. Callers sort/filter it.
func (s *Store) Snapshot() []*Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		out = append(out, sess)
	}
	return out
}

// Replay loads the journal from disk at boot, newest state wins.
func (s *Store) Replay() error {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		f, err := os.Open(filepath.Join(s.dir, e.Name()))
		if err != nil {
			return err
		}
		defer f.Close()
		var sess Session
		if err := json.NewDecoder(f).Decode(&sess); err != nil {
			continue
		}
		s.sessions[sess.ID] = &sess
	}
	return nil
}

// Close waits for in-flight journal writes.
func (s *Store) Close() {
	s.wg.Wait()
}

func (s *Store) journal(op string, sess *Session) {
	b, _ := json.Marshal(sess)
	path := filepath.Join(s.dir, sess.ID+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	os.Rename(tmp, path)
}
