# Needs librandomx (https://github.com/tevador/RandomX) and OpenSSL headers.
# RANDOMX=/path/to/prefix make        (prefix has include/randomx.h and lib/librandomx.a)
RANDOMX ?= /usr/local
CXX ?= g++
veilhash: veilhash.cpp
	$(CXX) -O2 -std=c++11 -pthread -I$(RANDOMX)/include -o $@ $< $(RANDOMX)/lib/librandomx.a -lcrypto
clean:
	rm -f veilhash
