const path = require('path');
const assert = require('assert');
const express = require('express');
const serve = require('serve-static');
const Nightmare = require('nightmare');
const getPort = require('get-port');
const fetch = require('node-fetch');
const walkSync = require('walk-sync');

run('production');
run('development');

Nightmare.action('page', {
	title(done) {
		this.evaluate_now(() => document.querySelector('h1').textContent, done);
	}
});

function run(env) {
	describe(`env=${env}`, function () {
		this.timeout(20000);

		let PORT;
		let server;
		let nightmare;
		let middleware;
		let capture;

		let base;

		function get(url) {
			return new Promise(fulfil => {
				const req = {
					url,
					method: 'GET'
				};

				const result = {
					headers: {},
					body: ''
				};

				const res = {
					set: (headers, value) => {
						if (typeof headers === 'string') {
							return res.set({ [headers]: value });
						}

						Object.assign(result.headers, headers);
					},

					status: code => {
						result.status = code;
					},

					write: data => {
						result.body += data;
					},

					end: data => {
						result.body += data;
						fulfil(result);
					}
				};

				middleware(req, res, () => {
					fulfil(result);
				});
			});
		}

		before(() => {
			process.chdir(path.resolve(__dirname, '../app'));

			process.env.NODE_ENV = env;

			let exec_promise = Promise.resolve();
			let sapper;

			if (env === 'production') {
				const cli = path.resolve(__dirname, '../../cli/index.js');
				exec_promise = exec(`${cli} build`).then(() => exec(`${cli} extract`));
			}

			return exec_promise.then(() => {
				const resolved = require.resolve('../..');
				delete require.cache[resolved];
				sapper = require(resolved);

				return getPort();
			}).then(port => {
				PORT = port;
				base = `http://localhost:${PORT}`;

				global.fetch = (url, opts) => {
					if (url[0] === '/') url = `${base}${url}`;
					return fetch(url, opts);
				};

				let captured;
				capture = fn => {
					const result = captured = [];
					return fn().then(() => {
						captured = null;
						return result;
					});
				};

				const app = express();

				app.use(serve('assets'));

				app.use((req, res, next) => {
					if (captured) captured.push(req);
					next();
				});

				middleware = sapper();
				app.use(middleware);

				return new Promise((fulfil, reject) => {
					server = app.listen(PORT, err => {
						if (err) reject(err);
						else fulfil();
					});
				});
			});
		});

		after(() => {
			server.close();
			middleware.close();

			// give a chance to clean up
			return new Promise(fulfil => setTimeout(fulfil, 500));
		});

		describe('basic functionality', () => {
			beforeEach(() => {
				nightmare = new Nightmare();

				nightmare.on('console', (type, ...args) => {
					console[type](...args);
				});

				nightmare.on('page', (type, ...args) => {
					if (type === 'error') {
						console.error(args[1]);
					} else {
						console.warn(type, args);
					}
				});
			});

			afterEach(() => {
				return nightmare.end();
			});

			it('serves /', () => {
				return nightmare.goto(base).page.title().then(title => {
					assert.equal(title, 'Great success!');
				});
			});

			it('serves static route', () => {
				return nightmare.goto(`${base}/about`).page.title().then(title => {
					assert.equal(title, 'About this site');
				});
			});

			it('serves dynamic route', () => {
				return nightmare.goto(`${base}/blog/what-is-sapper`).page.title().then(title => {
					assert.equal(title, 'What is Sapper?');
				});
			});

			it('navigates to a new page without reloading', () => {
				return nightmare.goto(base).wait(() => window.READY).wait(200)
					.then(() => {
						return capture(() => nightmare.click('a[href="/about"]'));
					})
					.then(requests => {
						assert.deepEqual(requests.map(r => r.url), []);
						return nightmare.path();
					})
					.then(path => {
						assert.equal(path, '/about');
						return nightmare.title();
					})
					.then(title => {
						assert.equal(title, 'About');
					});
			});

			it('navigates programmatically', () => {
				return nightmare
					.goto(`${base}/about`)
					.wait(() => window.READY)
					.click('.goto')
					.wait(() => window.location.pathname === '/blog/what-is-sapper')
					.wait(100)
					.title()
					.then(title => {
						assert.equal(title, 'What is Sapper?');
					});
			});

			it('prefetches programmatically', () => {
				return nightmare
					.goto(`${base}/about`)
					.wait(() => window.READY)
					.then(() => {
						return capture(() => {
							return nightmare
								.click('.prefetch')
								.wait(100);
						});
					})
					.then(requests => {
						assert.ok(!!requests.find(r => r.url === '/api/blog/why-the-name'));
					});
			});

			it('scrolls to active deeplink', () => {
				return nightmare
					.goto(`${base}/blog/a-very-long-post#four`)
					.wait(() => window.READY)
					.wait(100)
					.evaluate(() => window.scrollY)
					.then(scrollY => {
						assert.ok(scrollY > 0, scrollY);
					});
			});

			it('reuses prefetch promise', () => {
				return nightmare
					.goto(`${base}/blog`)
					.wait(() => window.READY)
					.wait(200)
					.then(() => {
						return capture(() => {
							return nightmare
								.mouseover('[href="/blog/what-is-sapper"]')
								.wait(200);
						});
					})
					.then(mouseover_requests => {
						assert.deepEqual(mouseover_requests.map(r => r.url), [
							'/api/blog/what-is-sapper'
						]);

						return capture(() => {
							return nightmare
								.click('[href="/blog/what-is-sapper"]')
								.wait(200);
						});
					})
					.then(click_requests => {
						assert.deepEqual(click_requests.map(r => r.url), []);
					});
			});

			it('cancels navigation if subsequent navigation occurs during preload', () => {
				return nightmare
					.goto(base)
					.wait(() => window.READY)
					.click('a[href="/slow-preload"]')
					.wait(100)
					.click('a[href="/about"]')
					.wait(100)
					.then(() => nightmare.path())
					.then(path => {
						assert.equal(path, '/about');
						return nightmare.title();
					})
					.then(title => {
						assert.equal(title, 'About');
						return nightmare.evaluate(() => window.fulfil({})).wait(100);
					})
					.then(() => nightmare.path())
					.then(path => {
						assert.equal(path, '/about');
						return nightmare.title();
					})
					.then(title => {
						assert.equal(title, 'About');
					});
			});

			it('passes entire request object to preload', () => {
				return nightmare
					.goto(`${base}/show-url`)
					.wait(() => window.READY)
					.evaluate(() => document.querySelector('p').innerHTML)
					.end().then(html => {
						assert.equal(html, `URL is /show-url`);
					});
			});

			it('calls a delete handler', () => {
				return nightmare
					.goto(`${base}/delete-test`)
					.wait(() => window.READY)
					.click('.del')
					.wait(() => window.deleted)
					.evaluate(() => window.deleted.id)
					.then(id => {
						assert.equal(id, 42);
					});
			});
		});

		describe('headers', () => {
			it('sets Content-Type and Link...preload headers', () => {
				return get('/').then(({ headers }) => {
					assert.equal(
						headers['Content-Type'],
						'text/html'
					);

					assert.ok(
						/<\/client\/main.\w+\.js>;rel="preload";as="script", <\/client\/_.\d+.\w+.js>;rel="preload";as="script"/.test(headers['Link']),
						headers['Link']
					);
				});
			});
		});

		if (env === 'production') {
			describe('extract', () => {
				it('extract all pages', () => {
					const dest = path.resolve(__dirname, '../app/dist');

					// Pages that should show up in the extraction directory.
					const expectedPages = [
						'index.html',
						'api/index.html',

						'about/index.html',
						'api/about/index.html',

						'slow-preload/index.html',
						'api/slow-preload/index.html',

						'blog/index.html',
						'api/blog/index.html',

						'blog/a-very-long-post/index.html',
						'api/blog/a-very-long-post/index.html',

						'blog/how-can-i-get-involved/index.html',
						'api/blog/how-can-i-get-involved/index.html',

						'blog/how-is-sapper-different-from-next/index.html',
						'api/blog/how-is-sapper-different-from-next/index.html',

						'blog/how-to-use-sapper/index.html',
						'api/blog/how-to-use-sapper/index.html',

						'blog/what-is-sapper/index.html',
						'api/blog/what-is-sapper/index.html',

						'blog/why-the-name/index.html',
						'api/blog/why-the-name/index.html',

						'favicon.png',
						'global.css',
						'great-success.png',
						'manifest.json',
						'service-worker.js',
						'svelte-logo-192.png',
						'svelte-logo-512.png',
					];
					// Client scripts that should show up in the extraction directory.
					const expectedClientRegexes = [
						/client\/_\..*?\.js/,
						/client\/about\..*?\.js/,
						/client\/blog_\$slug\$\..*?\.js/,
						/client\/blog\..*?\.js/,
						/client\/main\..*?\.js/,
						/client\/show_url\..*?\.js/,
						/client\/slow_preload\..*?\.js/,
					];
					const allPages = walkSync(dest);

					expectedPages.forEach((expectedPage) => {
						assert.ok(allPages.includes(expectedPage),
						    `Could not find page matching ${expectedPage}`);
					});
					expectedClientRegexes.forEach((expectedRegex) => {
						// Ensure each client page regular expression matches at least one
						// generated page.
						let matched = false;
						for (const page of allPages) {
							if (expectedRegex.test(page)) {
								matched = true;
								break;
							}
						}
						assert.ok(matched,
							  `Could not find client page matching ${expectedRegex}`);
					});
				});
			});
		}
	});
}

function exec(cmd) {
	return new Promise((fulfil, reject) => {
		require('child_process').exec(cmd, (err, stdout, stderr) => {
			process.stdout.write(stdout);
			process.stderr.write(stderr);

			if (err) return reject(err);
			fulfil();
		});
	});
}
