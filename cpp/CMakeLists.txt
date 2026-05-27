cmake_minimum_required(VERSION 3.15)
project(mesh_gen CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Requires CGAL installed via vcpkg.
# Build (PowerShell / Windows):
#   $env:VCPKG_ROOT = "C:/dev/vcpkg"
#   cmake -S cpp -B cpp/build -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
#   cmake --build cpp/build --config Release
#   Binary: cpp/build/Release/mesh_gen.exe
#
# Build (Linux / WSL2 — system CGAL, recommended):
#   sudo apt install -y libcgal-dev cmake build-essential
#   cd /mnt/d/New_Cgal_test_site          # WSL path to this project
#   cmake -S cpp -B cpp/build-linux -DCMAKE_BUILD_TYPE=Release
#   cmake --build cpp/build-linux -- -j$(nproc)
#   Binary: cpp/build-linux/mesh_gen

find_package(CGAL REQUIRED)

add_executable(mesh_gen mesh_gen.cpp)
target_link_libraries(mesh_gen PRIVATE CGAL::CGAL)
