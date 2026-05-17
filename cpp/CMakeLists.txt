cmake_minimum_required(VERSION 3.15)
project(cgal_test CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Requires CGAL installed via vcpkg.
# Build (PowerShell):
#   $env:VCPKG_ROOT = "C:/path/to/vcpkg"   # adjust to your vcpkg location
#   cmake -S cpp -B cpp/build -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
#   cmake --build cpp/build --config Release
# Resulting exe: cpp/build/Release/cgal_test.exe

find_package(CGAL CONFIG REQUIRED)

add_executable(cgal_test test_cgal.cpp)
target_link_libraries(cgal_test PRIVATE CGAL::CGAL)

add_executable(mesh_gen mesh_gen.cpp)
target_link_libraries(mesh_gen PRIVATE CGAL::CGAL)
