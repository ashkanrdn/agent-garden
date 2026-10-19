# Contributing

Open an issue before a large change. Describe the behavior, a reproduction, and the expected result.

Create a branch and keep commits focused. Run `npm test` and `python3 -m unittest discover -s tests/python`. Add synthetic fixtures for parser changes. Do not commit real exports, transcripts, private paths, or generated local data.

Open a pull request with the change, the checks you ran, and any known limits. Keep browser upload behavior local to the user's device.
