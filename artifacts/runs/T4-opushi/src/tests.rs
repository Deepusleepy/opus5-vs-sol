use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use super::{Clock, ManualClock, RateLimiter};

// ---------------------------------------------------------------- helpers --

/// Tokens available at the clock's current time, without taking any.
/// Reaches into crate internals so the float math can be asserted directly.
fn tokens(limiter: &RateLimiter) -> f64 {
    let inner = &limiter.inner;
    let now = inner.clock.now();
    let mut st = inner.lock();
    inner.available(&mut st, now)
}

/// `(tickets_issued, tickets_completed)`. A caller is queued in `acquire`
/// exactly when its ticket is issued but not yet completed.
fn queue(limiter: &RateLimiter) -> (u64, u64) {
    let st = limiter.inner.lock();
    (st.next_ticket, st.serving)
}

/// Spin (no sleeping) until the limiter's queue reaches an exact state.
/// Panics rather than hanging `cargo test` if the state never arrives.
fn await_queue(limiter: &RateLimiter, issued: u64, completed: u64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while queue(limiter) != (issued, completed) {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for queue state (issued {issued}, completed {completed}); \
             limiter is at {:?}",
            queue(limiter)
        );
        thread::yield_now();
    }
}

/// Give a thread a generous, non-sleeping window to make progress, then
/// assert it has not finished. Used for "must still be blocked" checks, where
/// no positive state transition exists to wait on.
fn assert_still_blocked(handle: &thread::JoinHandle<()>, what: &str) {
    for _ in 0..50_000 {
        assert!(!handle.is_finished(), "{what}");
        thread::yield_now();
    }
}

/// One "has this waiter been served yet" flag per spawned thread.
///
/// Recording service order by pushing to a shared Vec *after* `acquire`
/// returns does not work: the limiter's grant order is exact, but the
/// returning threads then race each other to the Vec. These flags are read
/// against the limiter's own `serving` counter instead, so the assertion sees
/// grant order rather than scheduler order.
#[derive(Clone)]
struct Served(Arc<Vec<AtomicUsize>>);

impl Served {
    fn new(n: usize) -> Self {
        Self(Arc::new((0..n).map(|_| AtomicUsize::new(0)).collect()))
    }

    fn mark(&self, i: usize) {
        self.0[i].store(1, Ordering::SeqCst);
    }

    /// Wait for waiter `i` to report served, and assert that every waiter in
    /// `must_still_wait` is still blocked while we do.
    ///
    /// Sound in both directions: a waiter can only mark itself after being
    /// granted, so a premature mark is a real ordering violation, and the
    /// wait cannot pass until the expected waiter is genuinely through.
    fn expect_next(&self, i: usize, must_still_wait: &[usize]) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.0[i].load(Ordering::SeqCst) == 0 {
            for &j in must_still_wait {
                assert_eq!(
                    self.0[j].load(Ordering::SeqCst),
                    0,
                    "waiter {j} was served before waiter {i}"
                );
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for waiter {i} to be served"
            );
            thread::yield_now();
        }
    }
}

/// Number of whole tokens sitting in the bucket right now. Consumes them.
fn drain(limiter: &RateLimiter) -> u32 {
    let mut n = 0;
    while limiter.try_acquire(1) {
        n += 1;
    }
    n
}

// -------------------------------------------------------------- exhaustion --

#[test]
fn starts_full_and_exhausts_at_capacity() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(5, 1.0, clock);

    assert_eq!(
        drain(&limiter),
        5,
        "a fresh bucket holds exactly `capacity`"
    );
    assert!(!limiter.try_acquire(1), "exhausted bucket grants nothing");
}

#[test]
fn exhaustion_is_exact_for_multi_token_requests() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(10, 1.0, clock);

    assert!(limiter.try_acquire(7));
    assert!(!limiter.try_acquire(4), "only 3 tokens remain");
    assert!(limiter.try_acquire(3));
    assert!(!limiter.try_acquire(1));
}

#[test]
fn zero_tokens_is_free_and_never_blocks() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(1, 1.0, clock);
    assert!(limiter.try_acquire(0));
    limiter.acquire(0);
    assert!(limiter.try_acquire(1), "the capacity token is untouched");
    assert!(limiter.try_acquire(0));
    limiter.acquire(0); // still free with an empty bucket
}

// ------------------------------------------------------------ refill math --

#[test]
fn refills_at_a_fractional_rate() {
    let clock = ManualClock::new();
    // 0.5 tokens/sec: one token every two seconds.
    let limiter = RateLimiter::with_clock(4, 0.5, clock.clone());
    assert_eq!(drain(&limiter), 4);

    clock.advance(Duration::from_secs(1));
    assert!(!limiter.try_acquire(1), "half a token is not a token");
    assert!((tokens(&limiter) - 0.5).abs() < 1e-12);

    clock.advance(Duration::from_secs(1));
    assert!(limiter.try_acquire(1), "two seconds -> one token");
    assert!(!limiter.try_acquire(1));

    clock.advance(Duration::from_secs(6));
    assert_eq!(drain(&limiter), 3, "six seconds -> three tokens");
}

#[test]
fn fractional_rate_below_one_per_second_accumulates_exactly() {
    let clock = ManualClock::new();
    // 1/3 token per second.
    let limiter = RateLimiter::with_clock(100, 1.0 / 3.0, clock.clone());
    assert_eq!(drain(&limiter), 100);

    clock.advance(Duration::from_secs(30));
    assert!((tokens(&limiter) - 10.0).abs() < 1e-9);
    assert!(limiter.try_acquire(10));
    assert!(!limiter.try_acquire(1));
}

#[test]
fn sub_millisecond_refill_is_not_rounded_away() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(1000, 1_000_000.0, clock.clone());
    assert_eq!(drain(&limiter), 1000);

    clock.advance(Duration::from_nanos(500));
    assert!(
        (tokens(&limiter) - 0.5).abs() < 1e-9,
        "500ns at 1e6 tokens/sec is half a token"
    );
}

#[test]
fn repeated_take_and_check_does_not_drift() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(10, 1000.0, clock.clone());
    assert_eq!(drain(&limiter), 10);

    // Each step earns 1.000001 tokens and spends 1, banking 1e-6. Over 5000
    // rounds that is exactly 0.005 tokens of credit -- unless the refill math
    // re-rounds on every check, in which case the residue wanders.
    let step = Duration::from_nanos(1_000_001);
    for i in 0..5000 {
        clock.advance(step);
        assert!(
            limiter.try_acquire(1),
            "round {i}: earned token went missing"
        );
        assert!(!limiter.try_acquire(1), "round {i}: bucket over-issued");
    }

    // Pin the banked credit: 0.005 tokens means 995us still to go.
    clock.advance(Duration::from_nanos(994_000));
    assert!(!limiter.try_acquire(1), "credit ran ahead of 0.005 tokens");
    clock.advance(Duration::from_nanos(2_000));
    assert!(limiter.try_acquire(1), "credit fell behind 0.005 tokens");
}

#[test]
fn tokens_never_go_negative() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(3, 7.0, clock.clone());

    for _ in 0..200 {
        clock.advance(Duration::from_micros(137));
        let before = tokens(&limiter);
        assert!(before >= 0.0, "available tokens went negative: {before}");
        limiter.try_acquire(1);
        let after = tokens(&limiter);
        assert!(
            after >= 0.0,
            "token count went negative after take: {after}"
        );
    }
}

// ------------------------------------------------------------ saturation --

#[test]
fn idle_bucket_saturates_at_capacity() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(6, 100.0, clock.clone());
    assert_eq!(drain(&limiter), 6);

    clock.advance(Duration::from_secs(3600)); // 360_000 tokens' worth
    assert_eq!(drain(&limiter), 6, "overflow is discarded, not banked");
}

#[test]
fn saturation_does_not_bank_credit_for_later() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(2, 1.0, clock.clone());

    clock.advance(Duration::from_secs(100)); // already full; 100 tokens lost
    assert_eq!(drain(&limiter), 2);

    // The very next second must yield one token, not the saturated backlog.
    clock.advance(Duration::from_secs(1));
    assert_eq!(drain(&limiter), 1);
}

#[test]
fn partial_use_then_long_idle_still_caps_at_capacity() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(8, 2.0, clock.clone());
    assert!(limiter.try_acquire(5));

    clock.advance(Duration::from_secs(1)); // +2 -> 5
    assert!((tokens(&limiter) - 5.0).abs() < 1e-12);

    clock.advance(Duration::from_secs(86_400));
    assert_eq!(drain(&limiter), 8);
}

#[test]
fn capacity_sized_request_is_satisfiable() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(4, 4.0, clock.clone());
    assert!(limiter.try_acquire(4));
    assert!(!limiter.try_acquire(4));
    clock.advance(Duration::from_secs(1));
    assert!(limiter.try_acquire(4), "a full bucket serves n == capacity");
}

// --------------------------------------------------------------- blocking --

#[test]
fn acquire_returns_immediately_when_tokens_are_present() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(3, 1.0, clock);
    limiter.acquire(3); // would hang forever if it needed a clock tick
    assert!(!limiter.try_acquire(1));
}

#[test]
fn acquire_blocks_until_the_clock_provides_tokens() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(2, 4.0, clock.clone());
    assert_eq!(drain(&limiter), 2);

    let waiter = limiter.clone();
    let handle = thread::spawn(move || waiter.acquire(2));

    await_queue(&limiter, 1, 0);

    clock.advance(Duration::from_millis(250)); // +1 token: not enough
    assert_still_blocked(&handle, "released on a partial refill");

    clock.advance(Duration::from_millis(250)); // +1 token: enough
    handle.join().expect("waiter panicked");
    assert!(!limiter.try_acquire(1), "waiter took exactly its 2 tokens");
}

// ---------------------------------------------------------------- fairness --

#[test]
fn a_queued_waiter_blocks_barging_try_acquires() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(10, 10.0, clock.clone());
    assert_eq!(drain(&limiter), 10);

    // One waiter wants the whole bucket.
    let waiter = limiter.clone();
    let big = thread::spawn(move || waiter.acquire(10));
    await_queue(&limiter, 1, 0);

    // A relentless stream of small requests, arriving faster than the refill,
    // for the entire second the big waiter needs. Under a naive limiter every
    // one of these would succeed and the big waiter would never be served.
    let mut stolen = 0;
    for _ in 0..100 {
        clock.advance(Duration::from_millis(9));
        for _ in 0..50 {
            if limiter.try_acquire(1) {
                stolen += 1;
            }
        }
    }
    assert_eq!(stolen, 0, "small requests barged past a queued waiter");

    // 900ms of refill is 9 tokens; the last one frees the waiter.
    clock.advance(Duration::from_millis(100));
    big.join().expect("waiter panicked");
}

#[test]
fn waiters_are_served_in_arrival_order() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(3, 1.0, clock.clone());
    assert_eq!(drain(&limiter), 3);

    let served = Served::new(3);
    let mut handles = Vec::new();

    // Arrival order is forced by waiting for each ticket to be issued before
    // spawning the next.
    for id in 0..3usize {
        let waiter = limiter.clone();
        let served = served.clone();
        handles.push(thread::spawn(move || {
            waiter.acquire(1);
            served.mark(id);
        }));
        await_queue(&limiter, id as u64 + 1, 0);
    }

    // One token per second, so exactly one waiter may proceed per advance.
    // Each step asserts the right one went and the later ones did not.
    clock.advance(Duration::from_secs(1));
    served.expect_next(0, &[1, 2]);
    clock.advance(Duration::from_secs(1));
    served.expect_next(1, &[2]);
    clock.advance(Duration::from_secs(1));
    served.expect_next(2, &[]);

    for h in handles {
        h.join().expect("waiter panicked");
    }
}

#[test]
fn a_large_waiter_is_not_starved_by_a_stream_of_small_acquires() {
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(4, 1.0, clock.clone());
    assert_eq!(drain(&limiter), 4);

    // Index 0 is the big waiter; 1..=20 are the small ones behind it.
    const SMALLS: usize = 20;
    let served = Served::new(SMALLS + 1);

    let waiter = limiter.clone();
    let big_served = served.clone();
    let big = thread::spawn(move || {
        waiter.acquire(4);
        big_served.mark(0);
    });
    await_queue(&limiter, 1, 0);

    let mut smalls = Vec::new();
    for i in 1..=SMALLS {
        let small = limiter.clone();
        let small_served = served.clone();
        smalls.push(thread::spawn(move || {
            small.acquire(1);
            small_served.mark(i);
        }));
        await_queue(&limiter, i as u64 + 1, 0);
    }

    // Four seconds of refill: exactly the big waiter's request. It must be
    // served first even though twenty cheaper requests are pending -- and
    // none of them may slip through while it waits.
    clock.advance(Duration::from_secs(4));
    let all_smalls: Vec<usize> = (1..=SMALLS).collect();
    served.expect_next(0, &all_smalls);

    // Drain the followers a second at a time, in order. Advancing 20s in one
    // jump would not work and should not: capacity is 4, so the surplus is
    // correctly discarded rather than banked for the queue.
    for i in 1..=SMALLS {
        clock.advance(Duration::from_secs(1));
        served.expect_next(i, &all_smalls[i..]);
    }

    big.join().expect("big waiter panicked");
    for h in smalls {
        h.join().expect("small waiter panicked");
    }
}

#[test]
fn a_departing_waiter_hands_off_to_the_whole_queue() {
    const FOLLOWERS: u64 = 30;
    const CAPACITY: u32 = 40;

    // Every handoff here happens with no clock event behind it: the tokens
    // the followers need already exist when the head leaves, so the only
    // thing that can wake them is the limiter's own notification. A limiter
    // that wakes just one waiter per departure strands the queue, because
    // the woken thread is not necessarily the next head.
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(CAPACITY, 1.0, clock.clone());
    assert_eq!(drain(&limiter), CAPACITY);

    // Head wants 10 and cannot be served yet.
    let head = limiter.clone();
    let head_handle = thread::spawn(move || head.acquire(10));
    await_queue(&limiter, 1, 0);

    // Followers queue behind it. try_acquire deferral means acquire defers
    // too, so they queue even once tokens exist.
    let mut handles = Vec::new();
    for i in 0..FOLLOWERS {
        let follower = limiter.clone();
        handles.push(thread::spawn(move || follower.acquire(1)));
        await_queue(&limiter, i + 2, 0);
    }

    // One advance mints 40 tokens: 10 for the head and one for each of the
    // 30 followers, exactly. From here the queue must drain unaided.
    clock.advance(Duration::from_secs(40));
    await_queue(&limiter, FOLLOWERS + 1, FOLLOWERS + 1);

    head_handle.join().expect("head panicked");
    for h in handles {
        h.join().expect("follower panicked");
    }
    assert!(!limiter.try_acquire(1), "all 40 tokens should be spent");
}

// -------------------------------------------------------------- concurrency --

#[test]
fn try_acquire_storm_issues_each_token_exactly_once() {
    const THREADS: usize = 16;
    const ATTEMPTS: usize = 500;
    const CAPACITY: u32 = 64;

    // Frozen clock: the bucket's whole lifetime supply is `CAPACITY`, so the
    // total number of successes across all threads pins double-issue exactly.
    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(CAPACITY, 1.0, clock);
    let start = Arc::new(Barrier::new(THREADS));
    let granted = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for _ in 0..THREADS {
        let limiter = limiter.clone();
        let start = Arc::clone(&start);
        let granted = Arc::clone(&granted);
        handles.push(thread::spawn(move || {
            start.wait();
            for _ in 0..ATTEMPTS {
                if limiter.try_acquire(1) {
                    granted.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for h in handles {
        h.join().expect("worker panicked");
    }

    assert_eq!(
        granted.load(Ordering::Relaxed),
        CAPACITY as usize,
        "tokens were lost or issued twice under contention"
    );
    assert!(!limiter.try_acquire(1));
}

#[test]
fn concurrent_acquire_storm_conserves_tokens() {
    const THREADS: u64 = 40;
    const CAPACITY: u32 = 8;
    const RATE: f64 = 1000.0; // 1 token per millisecond

    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(CAPACITY, RATE, clock.clone());

    let mut handles = Vec::new();
    for _ in 0..THREADS {
        let limiter = limiter.clone();
        handles.push(thread::spawn(move || limiter.acquire(1)));
    }

    // Settle: the frozen bucket serves exactly CAPACITY of them, the rest
    // queue. Asserting the exact pair rules out a half-registered thread.
    await_queue(&limiter, THREADS, u64::from(CAPACITY));

    // Release the remaining waiters one at a time. Handing out a token and
    // waiting for it to be consumed before minting the next keeps the bucket
    // away from its ceiling, so no refill is lost to saturation and the
    // budget below is exact.
    let step = Duration::from_micros(1001); // 1.001 tokens
    let remaining = THREADS - u64::from(CAPACITY);
    for i in 0..remaining {
        clock.advance(step);
        await_queue(&limiter, THREADS, u64::from(CAPACITY) + i + 1);
    }
    for h in handles {
        h.join().expect("waiter panicked");
    }

    // Conservation: issued + left_in_bucket == started_with + refilled.
    //   started 8 + refilled (32 * 1.001 + 4.468) = 44.5
    //   issued  40                     => 4.5 tokens must remain.
    clock.advance(Duration::from_micros(4468));
    assert_eq!(
        drain(&limiter),
        4,
        "bucket balance does not match tokens issued"
    );
}

#[test]
fn mixed_storm_of_acquire_and_try_acquire_conserves_tokens() {
    const WAITERS: u64 = 12;
    const HAMMERERS: usize = 6;
    const CAPACITY: u32 = 4;

    let clock = ManualClock::new();
    let limiter = RateLimiter::with_clock(CAPACITY, 1000.0, clock.clone());
    let stolen = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for _ in 0..WAITERS {
        let limiter = limiter.clone();
        handles.push(thread::spawn(move || limiter.acquire(1)));
    }
    await_queue(&limiter, WAITERS, u64::from(CAPACITY));

    // Hammer try_acquire throughout. Every one must fail: waiters are queued
    // for the entire run, so nothing may barge.
    let mut hammers = Vec::new();
    for _ in 0..HAMMERERS {
        let limiter = limiter.clone();
        let stolen = Arc::clone(&stolen);
        let stop = Arc::clone(&stop);
        hammers.push(thread::spawn(move || {
            while stop.load(Ordering::Relaxed) == 0 {
                if limiter.try_acquire(1) {
                    stolen.fetch_add(1, Ordering::Relaxed);
                }
                // Keep the state lock available to the waiters; without this
                // the test measures scheduler luck rather than the limiter.
                thread::yield_now();
            }
        }));
    }

    // Release all but the last waiter. The hammerers are stopped and joined
    // while that one is still queued, so every try_acquire they ever made
    // raced against a non-empty queue -- once the queue drains, a successful
    // try_acquire would be correct and would tell us nothing.
    let remaining = WAITERS - u64::from(CAPACITY);
    for i in 0..remaining - 1 {
        clock.advance(Duration::from_micros(1001));
        await_queue(&limiter, WAITERS, u64::from(CAPACITY) + i + 1);
    }
    stop.store(1, Ordering::Relaxed);
    for h in hammers {
        h.join().expect("hammerer panicked");
    }
    assert_eq!(
        stolen.load(Ordering::Relaxed),
        0,
        "try_acquire barged past queued waiters"
    );

    clock.advance(Duration::from_micros(1001));
    for h in handles {
        h.join().expect("waiter panicked");
    }

    // Conservation, kept clear of the ceiling so no refill is lost:
    // 4 started + 1000/s * 11.5ms = 15.5 minted, 12 issued -> 3.5 left.
    clock.advance(Duration::from_micros(3492));
    assert_eq!(drain(&limiter), 3, "bucket balance does not match");
}

// ---------------------------------------------------- construction guards --

#[test]
#[should_panic(expected = "capacity must be greater than zero")]
fn zero_capacity_is_rejected() {
    RateLimiter::new(0, 1.0);
}

#[test]
#[should_panic(expected = "refill_per_sec must be finite and greater than zero")]
fn zero_rate_is_rejected() {
    RateLimiter::new(1, 0.0);
}

#[test]
#[should_panic(expected = "refill_per_sec must be finite and greater than zero")]
fn nan_rate_is_rejected() {
    RateLimiter::new(1, f64::NAN);
}

#[test]
#[should_panic(expected = "can never be satisfied")]
fn try_acquire_beyond_capacity_is_rejected() {
    RateLimiter::new(4, 1.0).try_acquire(5);
}

#[test]
#[should_panic(expected = "can never be satisfied")]
fn acquire_beyond_capacity_is_rejected() {
    RateLimiter::new(4, 1.0).acquire(5);
}

// --------------------------------------------------------------- plumbing --

#[test]
fn waking_a_dropped_limiter_is_harmless() {
    let clock = ManualClock::new();
    drop(RateLimiter::with_clock(1, 1.0, clock.clone()));
    clock.advance(Duration::from_secs(1)); // must not panic or deadlock
    assert_eq!(clock.now(), Duration::from_secs(1));
}

#[test]
fn clones_share_one_bucket() {
    let clock = ManualClock::new();
    let a = RateLimiter::with_clock(2, 1.0, clock);
    let b = a.clone();
    assert_eq!(a.capacity(), 2);
    assert!(a.try_acquire(1));
    assert!(b.try_acquire(1));
    assert!(!a.try_acquire(1), "clones are not independent buckets");
}

// ------------------------------------------------------------- smoke test --

/// The only test that uses real time. Budget: well under 500ms.
#[test]
fn smoke_real_clock_blocks_for_about_the_right_time() {
    let limiter = RateLimiter::new(2, 100.0); // one token per 10ms
    assert!(limiter.try_acquire(2));
    assert!(!limiter.try_acquire(1));

    // 5 tokens at 100/sec == 50ms of blocking, spread over two calls.
    let start = Instant::now();
    limiter.acquire(2);
    let worker = limiter.clone();
    let handle = thread::spawn(move || worker.acquire(2));
    limiter.acquire(1);
    handle.join().expect("waiter panicked");
    let elapsed = start.elapsed();

    assert!(
        elapsed >= Duration::from_millis(45),
        "returned too early: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(400),
        "blocked far too long (busy-spin or missed wakeup?): {elapsed:?}"
    );
}
