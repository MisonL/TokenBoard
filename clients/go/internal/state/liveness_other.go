//go:build !darwin && !linux && !windows

package state

import "errors"

func platformProcessStartIdentity(int) (string, error) {
	return "", errors.New("process start identity unsupported on this platform")
}
