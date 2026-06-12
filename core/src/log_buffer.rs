//! Process-wide ring buffer of recent log lines (WARN+ERROR), capped to a
//! configurable capacity. Used to feed the optional "log_excerpt" attachment
//! when submitting feedback.
//!
//! The desktop host installs a `tracing_subscriber` Layer (in src-tauri) that
//! pushes formatted lines here. The client UI never touches log files on disk.

use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;

#[derive(Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<VecDeque<String>>>,
    capacity: usize,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(capacity))),
            capacity,
        }
    }

    pub fn push(&self, line: String) {
        let mut g = self.inner.lock();
        if g.len() == self.capacity {
            g.pop_front();
        }
        g.push_back(line);
    }

    pub fn snapshot(&self) -> Vec<String> {
        self.inner.lock().iter().cloned().collect()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pushes_and_caps() {
        let b = LogBuffer::new(3);
        b.push("a".into());
        b.push("b".into());
        b.push("c".into());
        b.push("d".into());
        let snap = b.snapshot();
        assert_eq!(snap, vec!["b", "c", "d"]);
    }
}
