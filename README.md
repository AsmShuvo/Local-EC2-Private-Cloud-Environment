# EC2-Replica

A local OpenStack sandbox built with DevStack to mimic an AWS EC2 environment on a single Ubuntu box. The idea is to have somewhere to spin up VMs, images and networks without paying AWS or touching the cloud.

Everything runs on one machine. Not meant for production, just a lab.

## Requirements

- Ubuntu 22.04 (use DevStack `stable/2023.1`) or 24.04 (use `stable/2024.1`)
- A machine you don't mind wiping — DevStack makes a mess and the clean way to reset is to rebuild the box
- Ideally a static IP, or at least one that won't change under you
- 8GB RAM minimum, more is better

