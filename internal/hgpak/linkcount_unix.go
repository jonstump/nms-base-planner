//go:build unix

package hgpak

import (
	"os"
	"syscall"
)

// hardLinkCount reports how many directory entries refer to the same inode,
// when the platform exposes it. A count above one means writing through this
// path also rewrites whatever else points at the inode.
func hardLinkCount(fi os.FileInfo) (uint64, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Nlink), true
}
