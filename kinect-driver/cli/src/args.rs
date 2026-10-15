//! A small command line parser (no dependency): `--name value`, `--name=value`, `--flag`, and
//! positional arguments; whatever is left over is an error.

use std::collections::VecDeque;

pub struct Args {
    rest: VecDeque<String>,
}

impl Args {
    pub fn new(args: impl IntoIterator<Item = String>) -> Args {
        // --name=value becomes --name value
        let mut rest = VecDeque::new();
        for a in args {
            match a.split_once('=') {
                Some((k, v)) if k.starts_with("--") => {
                    rest.push_back(k.to_string());
                    rest.push_back(v.to_string());
                }
                _ => rest.push_back(a),
            }
        }
        Args { rest }
    }

    /// True if `--name` was given (removes it).
    pub fn flag(&mut self, name: &str) -> bool {
        match self.rest.iter().position(|a| a == name) {
            Some(i) => {
                self.rest.remove(i);
                true
            }
            None => false,
        }
    }

    /// The value after `--name` (removes both).
    pub fn value(&mut self, name: &str) -> Result<Option<String>, String> {
        let Some(i) = self.rest.iter().position(|a| a == name) else { return Ok(None) };
        self.rest.remove(i);
        match self.rest.remove(i) {
            Some(v) => Ok(Some(v)),
            None => Err(format!("{name} needs a value")),
        }
    }

    /// A number after `--name`.
    pub fn number<T: std::str::FromStr>(&mut self, name: &str) -> Result<Option<T>, String> {
        match self.value(name)? {
            Some(v) => v.parse().map(Some).map_err(|_| format!("{name}: {v:?} is not a number")),
            None => Ok(None),
        }
    }

    /// The next positional argument.
    pub fn positional(&mut self) -> Option<String> {
        let i = self.rest.iter().position(|a| !a.starts_with("--"))?;
        self.rest.remove(i)
    }

    /// Fails if anything is left.
    pub fn done(&self) -> Result<(), String> {
        match self.rest.front() {
            Some(a) => Err(format!("unknown argument {a:?} (see kinect-driver help)")),
            None => Ok(()),
        }
    }
}
