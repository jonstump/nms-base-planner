//go:build !unix

package hgpak

import "os"

// hardLinkCount has no portable implementation off unix. Reporting "unknown"
// leaves the symlink check as the only destination guard on those platforms,
// which is the pre-existing behaviour rather than a regression.
func hardLinkCount(os.FileInfo) (uint64, bool) { return 0, false }
