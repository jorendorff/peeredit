# Peeredit - A collaborative text editor to illustrate CRDTs

**Peeredit** is a simple Web app that lets you edit some text online with friends.

This is example code
for a talk on [CRDTs](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type).

*   Server code is in
    [index.js](https://github.com/jorendorff/peeredit/blob/master/index.js).

*   Browser code is in
    [index.html](https://github.com/jorendorff/peeredit/blob/master/index.html).

*   They share a data structure defined in
    [lib/rga.js](https://github.com/jorendorff/peeredit/blob/master/lib/rga.js).

Is this unnecessarily complicated?
There are several simpler approaches, but they all have problems: see
[Clobberation](https://github.com/jorendorff/clobberation),
[Quilljoy](https://github.com/jorendorff/quilljoy), and
[Univax](https://github.com/jorendorff/univax).


## How to run Peeredit

    $ npm install
    $ npm run start

Then point your browser at http://localhost:3001/ .

(Note to myself: do `nvm use 6` first!)

Use Mocha to run the tests.
If you don't already have Mocha, you can avoid installing it globally
by using this hack instead:

    $ npm install mocha
    $ ./node_modules/.bin/mocha

