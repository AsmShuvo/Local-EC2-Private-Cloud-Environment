echo "=== Cloud Host Hardware Audit ==="

free -h

egrep -c '(vmx|svm)' /proc/cpuinfo
